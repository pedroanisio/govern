// The business event and lifecycle commands: events, timers, alerts, subprocesses, recovery, typed case data, human tasks and policy
// rejections. The runtime they drive (lib/lifecycle.ts) and the graph processes (lib/business.ts) stay in the core: advance,
// approve and the brief depend on them. A workspace turns this extension on with `govern ext enable business`.
import { userInfo } from "node:os";
import { eventServer } from "./event-server.ts";
import * as lifecycle from "../../lib/lifecycle.ts";
import { activeStages, requireActive, setData, authenticatedPerson, humanAction } from "../../lib/business.ts";
import { scalar, value } from "../../lib/business-schema.ts";
import { check, record } from "../../lib/shape.ts";
import { verifyQuote } from "../../lib/approval.ts";
import { GovernError, fail, parseArgs, opt, flag, secondsOpt, nowIso } from "../../lib/util.ts";
import type { Args } from "../../lib/util.ts";
import { load, save, appendLedger, laneSlugs, checkSlug } from "../../lib/project.ts";
import { processOf } from "../../lib/process.ts";
import { out, jsonValue, core, type Cmd } from "../../lib/cli.ts";
import type { ExtDoc } from "../../lib/ext-registry.ts";
import { MANPAGE } from "./manpage.ts";

function cmdData(a:Args):void {
  const p=load(a._[1]), text=opt(a,'set');
  if(text!==undefined) {
    let raw:unknown; try {raw=JSON.parse(text);} catch {fail('--set must be a JSON object');}
    const patch=check('case data',raw,record(value));
    setData(p,patch); save(p); appendLedger(p.slug,{kind:'data',fields:Object.keys(patch)});
  }
  out(JSON.stringify(p.data??{},null,2));
}
function cmdHumanInbox(a:Args):void {
  const requested=opt(a,'as'), user=userInfo().username, rows:string[]=[];
  let authenticated=false;
  for(const slug of laneSlugs()) {
    const p=load(slug), pr=processOf(p);
    const actor=Object.keys(pr.people??{}).find(id=>pr.people![id]!.user===user && (!requested || id===requested));
    if(!actor) continue;
    authenticated=true;
    for(const stage of activeStages(p)) {
      const def=pr.stages.find(s=>s.name===stage)?.human, task=p.humanTasks?.[stage];
      if(!def || task?.completedAt) continue;
      if(task?.assignee===actor || (!task?.assignee && def.role && pr.people![actor]!.roles?.includes(def.role))) rows.push(`${slug} ${stage}: ${task?.assignee ? `assigned to ${actor}` : `unclaimed (${def.role})`}`);
    }
  }
  if(requested && !authenticated) fail(`OS account ${user} is not authenticated as ${requested}`);
  out(rows.join('\n')||'(no human tasks for this account)');
}
function cmdHuman(a:Args):void {
  const p=load(a._[1]), action=a._[2]??'list';
  if(action==='list') { out(Object.entries(p.humanTasks??{}).map(([s,t])=>`${s}: ${t.completedAt ? `completed by ${t.completedBy}` : t.assignee??'unclaimed'}${activeStages(p).includes(s)?' (active)':''}`).join('\n')||'(no human tasks)'); return; }
  if(!['claim','delegate','complete'].includes(action)) fail('human action must be list, claim, delegate or complete');
  const stage=a._[3]??fail('human action requires a stage'), quote=opt(a,'quote');
  if(!quote || quote.trim().length<2) fail('--quote is required: the human instruction');
  const actor=authenticatedPerson(processOf(p),opt(a,'as')), source=verifyQuote(quote!);
  humanAction(p,stage,action as 'claim'|'delegate'|'complete',actor,quote!,opt(a,'to'));
  save(p); appendLedger(p.slug,{kind:'human-'+action,stage,by:actor,to:opt(a,'to'),quote,source});
  out(`${p.slug}: ${stage} ${action} by ${actor}`);
}
function cmdEvent(a:Args):void {
  const p=load(a._[1]),name=a._[2]??fail('event name required'),id=opt(a,'id')??fail('--id required'),correlation=check('correlation',jsonValue(opt(a,'correlation'),null),scalar);
  const data=check('event data',jsonValue(opt(a,'data')),record(scalar)),generation=secondsOpt(a,'generation');if(generation!==undefined&&!Number.isSafeInteger(generation))fail('--generation must be a positive safe integer');
  const accepted=lifecycle.deliverEvent(p,name,id,correlation,data,generation);save(p);out(accepted?'event accepted; stage ready':'duplicate event ignored');
}
function cmdRecover(a:Args):void {
  const p=load(a._[1]),stage=opt(a,'stage')??p.stage;requireActive(p,stage);p.stage=stage;
  const action=opt(a,'action');if(action!=='retry'&&action!=='compensated')fail('--action must be retry or compensated');
  const quote=opt(a,'quote');if(!quote||quote.trim().length<2)fail('--quote is required: the human recovery decision');
  const source=verifyQuote(quote!);lifecycle.recover(p,action as 'retry'|'compensated',quote!);save(p);appendLedger(p.slug,{kind:'recover-source',source});out(`${p.slug}: recovery recorded`);
}
function cmdTick(a:Args):void {
  const interval=secondsOpt(a,'interval')??30,advance=flag(a,'advance');
  const once=()=>{
    let failed=false;
    for(const slug of a._[1]?[checkSlug(a._[1])]:laneSlugs())try{lifecycle.transaction(slug,()=>{
      const p=load(slug);if(p.finished)return;const emitted=lifecycle.tickTimers(p);save(p);if(emitted)out(`${slug}: ${emitted} timer alerts`);
      if(!advance)return;
      for(const stage of [...activeStages(p)]){
        const current=load(slug);if(!activeStages(current).includes(stage))continue;
        const s=processOf(current).stages.find(s=>s.name===stage)!,r=current.runtime?.[stage];
        if(s.call||s.foreach)lifecycle.syncChild(current,stage);
        if(!(r?.eventId||r?.childSynced||r?.batch?.synced||(r?.retryAt&&Date.parse(r.retryAt)<=Date.now())))continue;
        const args=parseArgs([slug,'--stage',stage,'--note','Declared workflow event, child completion or scheduled retry verified'],{value:['stage','note']},'advance');args._.unshift('advance');core.advance!(args);
      }
    });}catch(e){if(!(e instanceof GovernError))throw e;failed=true;out(`${slug}: blocked: ${e.message}`);}
    if(failed&&!flag(a,'loop'))process.exitCode=1;
  };
  once();if(flag(a,'loop'))setInterval(once,interval*1000);
}

export const name = "business";
export const description = "business events and lifecycle commands: events, timers, alerts, subprocesses, recovery, case data and human tasks";
export const docs: ExtDoc[] = [
  { title: "typed case data, conditional routes, parallel joins, human tasks, quorum approval policies", path: "BUSINESS.md" },
  { title: "timers, business calendars, events, recovery, subprocesses, process revisions", path: "LIFECYCLE.md" },
];
export const manpage = MANPAGE;
export const commands: Cmd[] = [
  {name:'event',section:1,flags:{value:['id','correlation','data','generation']},lines:[["<slug> <name> --id ID --correlation JSON [--data JSON] [--generation N]","deliver a deduplicated event to one matching active stage; adapters supply a stable id"]],run:cmdEvent},
  {name:'event-listen',section:1,flags:{value:['port']},lines:[["[--port 5001]","loopback POST /events listener; Bearer token comes from GOVERN_WEBHOOK_TOKEN (minimum 16 characters)"]],run:a=>{
    const token=process.env.GOVERN_WEBHOOK_TOKEN??fail('GOVERN_WEBHOOK_TOKEN is not set; configure it securely before starting the listener');
    const port=Number(opt(a,'port')??5001);if(!Number.isInteger(port)||port<1||port>65535)fail('--port must be 1..65535');
    const server=eventServer(token);server.on('error',e=>{process.stderr.write(`event listener: ${e.message}\n`);process.exitCode=1;});server.listen(port,'127.0.0.1',()=>out(`event listener ready on port ${port}`));
  }},
  {name:'tick',section:1,flags:{value:['interval'],bool:['advance','loop']},lines:[["[<slug>] [--advance] [--loop --interval 30]","emit due reminders/escalations; optionally advance ready event, child and retry stages through normal checks and gates"]],run:cmdTick},
  {name:'alerts',section:1,flags:{value:['ack']},lines:[["<slug> [--ack ID]","list timer alerts or acknowledge one; acknowledgement does not approve a gate"]],run:a=>{
    const p=load(a._[1]),id=opt(a,'ack');if(id){const alert=p.alerts?.find(x=>x.id===id)??fail('unknown alert');alert.acknowledgedAt=nowIso();save(p);appendLedger(p.slug,{kind:'alert-ack',id});}
    out((p.alerts??[]).map(x=>`${x.id} ${x.kind} ${x.acknowledgedAt?'acknowledged':'open'}: ${x.message}`).join('\n')||'(no alerts)');
  }},
  {name:'subprocess',section:1,lines:[["<slug> <stage>","start the declared child if needed and sync its outputs only after it finishes"]],run:a=>{
    const p=load(a._[1]),stage=a._[2]??p.stage,ready=lifecycle.syncChild(p,stage);out(`${stage}: ${ready?'child complete; outputs synced':`waiting for ${p.runtime![stage]!.batch ? `${Object.keys(p.runtime![stage]!.batch!.children).length}/${p.runtime![stage]!.batch!.items.length} item cases` : p.runtime![stage]!.child}`}`);
  }},
  {name:'recover',section:1,flags:{value:['stage','action','quote']},lines:[["<slug> [--stage S] --action retry|compensated --quote Q","human recovery: reset exhausted retries, or confirm compensation after investigating an uncertain result"]],run:cmdRecover},
  { name: "human", section: 1, flags: { value: ["as", "to", "quote"] },
    lines: [["<slug> [list | claim|delegate|complete STAGE] [--as PERSON] [--to PERSON] [--quote Q]", "list, claim, delegate or complete stage tasks; person identity is mapped to the current OS account; mutations require verified human words"]], run: cmdHuman },
  { name: "human-inbox", section: 1, flags: { value: ["as"] },
    lines: [["[--as PERSON]", "active tasks assigned to this OS account or claimable through its process roles"]], run: cmdHumanInbox },
  { name: "data", section: 1, flags: { value: ["set"] },
    lines: [["<slug> [--set JSON]", "read or merge typed case fields; changed data invalidates policy votes and active human task completion"]], run: cmdData },
  { name: "reject", section: 1, flags: { value: ["quote", "by"] },
    lines: [["<slug> <gate> --quote Q [--by PERSON]", "reject a policy gate; follows rejectTo when declared, otherwise blocks the gate"]],
    run: (a) => { const p=load(a._[1]); const g=processOf(p).gates.find(g=>g.name===a._[2])??fail('unknown gate'); core.policyDecision!(a,p,g,'reject'); } },
];
