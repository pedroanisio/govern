package dev.supertools.govern.remote.ui

import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.supertools.govern.remote.R
import dev.supertools.govern.remote.protocol.*

/** Asks the person to confirm and sign: title, summary, exact body and success message. */
typealias Confirm = (String, String, ByteArray, String) -> Unit

@Composable
fun App(model: AppModel, confirm: Confirm) {
    FieldTheme {
        val current by model.current.collectAsStateWithLifecycle()
        val hosts by model.hosts.collectAsStateWithLifecycle()
        val pairing by model.pairing.collectAsStateWithLifecycle()
        val message by model.message.collectAsStateWithLifecycle()
        val snack = remember { SnackbarHostState() }
        LaunchedEffect(message) { message?.let { snack.showSnackbar(it); model.consumeMessage() } }
        Surface(Modifier.fillMaxSize()) {
            Scaffold(snackbarHost = { SnackbarHost(snack) }) { pad ->
                Box(Modifier.padding(pad)) {
                    if (pairing || hosts.isEmpty()) PairScreen(model, hosts.isNotEmpty())
                    else current?.let { Main(model, it, confirm) }
                }
            }
        }
    }
}

@Composable
private fun PairScreen(model: AppModel, canCancel: Boolean) {
    val busy by model.busy.collectAsStateWithLifecycle()
    val prefill by model.prefill.collectAsStateWithLifecycle()
    var address by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var pin by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf(Build.MODEL.orEmpty()) }
    BackHandler(canCancel) { model.cancelPairing() }
    LaunchedEffect(prefill) {
        prefill?.let { address = it.url; code = it.code; pin = it.pin.orEmpty(); model.consumePrefill() }
    }
    Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.connect_session), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.pair_instructions))
        OutlinedTextField(address, { address = it }, Modifier.fillMaxWidth(), enabled = !busy, label = { Text(stringResource(R.string.server_address)) }, singleLine = true)
        if (!address.trim().startsWith("govern-remote:")) {
            OutlinedTextField(code, { code = it }, Modifier.fillMaxWidth(), enabled = !busy, textStyle = FieldCode, label = { Text(stringResource(R.string.pair_code)) }, singleLine = true)
            OutlinedTextField(pin, { pin = it }, Modifier.fillMaxWidth(), enabled = !busy, textStyle = FieldCode, label = { Text(stringResource(R.string.certificate_pin)) }, singleLine = true)
        }
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), enabled = !busy, label = { Text(stringResource(R.string.device_name)) }, singleLine = true)
        Button({ model.pair(address, code, pin, name) }, enabled = !busy && address.isNotBlank()) {
            Text(stringResource(if (busy) R.string.pairing else R.string.pair))
        }
        if (canCancel) TextButton(model::cancelPairing, enabled = !busy) { Text(stringResource(R.string.cancel)) }
        Text(stringResource(R.string.pair_security), style = MaterialTheme.typography.bodySmall)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Main(model: AppModel, state: HostState, confirm: Confirm) {
    val lane by model.lane.collectAsStateWithLifecycle()
    val hosts by model.hosts.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableIntStateOf(0) }
    BackHandler(lane != null || tab != 0) { if (lane != null) model.closeLane() else tab = 0 }
    val tabs = listOf(R.string.operation, R.string.hosts, R.string.decisions, R.string.activity)
    val icons = listOf(R.drawable.ic_operation, R.drawable.ic_hosts, R.drawable.ic_decisions, R.drawable.ic_activity)
    Scaffold(contentWindowInsets = WindowInsets(0, 0, 0, 0), bottomBar = {
        NavigationBar(windowInsets = WindowInsets(0, 0, 0, 0)) {
            tabs.forEachIndexed { index, label ->
                NavigationBarItem(selected = index == tab, onClick = { model.closeLane(); tab = index },
                    icon = { Icon(painterResource(icons[index]), contentDescription = null) },
                    label = { Text(stringResource(label)) })
            }
        }
    }) { pad ->
        Column(Modifier.padding(pad)) {
            TopAppBar(windowInsets = WindowInsets(0, 0, 0, 0), title = { Column {
                Text(stringResource(R.string.app_name))
                Text(state.host.name, style = MaterialTheme.typography.labelSmall)
            } })
            StatusBanner(state, if (lane != null) model.laneAt.collectAsStateWithLifecycle().value else null)
            val detail = lane
            if (detail != null) LaneScreen(detail, state, model, confirm)
            else when (tab) {
                0 -> state.desk?.let { DeskScreen(it, model::openLane) } ?: Empty(R.string.waiting_desk)
                1 -> HostsScreen(hosts, state.host.id, model)
                2 -> DecisionsScreen(hosts) { decision -> model.selectHost(decision.host.id); model.openLane(decision.lane.slug) }
                3 -> ActivityScreen(state, model)
            }
        }
    }
}

@Composable
private fun StatusBanner(state: HostState, at: String? = null) {
    val live = state.link == Link.Live
    val cached = state.desk != null || at != null
    val label = when {
        live -> stringResource(R.string.live)
        cached -> stringResource(R.string.cached_at, at ?: state.desk!!.at)
        state.link == Link.Connecting -> stringResource(R.string.connecting)
        else -> stringResource(R.string.offline)
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text(label, color = if (live) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        if (live) Text(stringResource(R.string.authorized_control), style = MaterialTheme.typography.labelSmall)
        when (val link = state.link) {
            is Link.Retrying -> Text(stringResource(R.string.retrying, link.seconds, link.reason), style = MaterialTheme.typography.bodySmall)
            is Link.Stopped -> Text(link.reason, style = MaterialTheme.typography.bodySmall)
            else -> Unit
        }
    }
}

@Composable
private fun HostsScreen(hosts: List<HostState>, selected: String, model: AppModel) {
    val busy by model.busy.collectAsStateWithLifecycle()
    var forgetting by remember { mutableStateOf<HostState?>(null) }
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Button(model::beginPairing, enabled = !busy) { Text(stringResource(R.string.pair_another_host)) } }
        items(hosts, key = { it.host.id }) { state ->
            Card(Modifier.fillMaxWidth().clickable { model.selectHost(state.host.id) }) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(state.host.name, fontWeight = FontWeight.Bold)
                    Text(state.host.baseUrl, style = MaterialTheme.typography.bodySmall)
                    Text(stringResource(R.string.host_identity, state.host.person, state.host.deviceId), style = FieldCode)
                    state.host.pin?.let { Text(it, style = FieldCode) }
                    Text(stringResource(if (state.link == Link.Live) R.string.live else if (state.desk != null) R.string.cached else R.string.offline))
                    Text(stringResource(R.string.scope, state.host.lanes?.joinToString(", ") ?: stringResource(R.string.all)))
                    if (state.host.id == selected) Text(stringResource(R.string.selected), color = MaterialTheme.colorScheme.primary)
                    TextButton({ forgetting = state }, enabled = !busy) { Text(stringResource(R.string.forget_host)) }
                }
            }
        }
    }
    forgetting?.let { state ->
        AlertDialog(onDismissRequest = { forgetting = null }, title = { Text(stringResource(R.string.forget_host)) },
            text = { Text(stringResource(R.string.forget_description, state.host.name)) },
            confirmButton = { TextButton({ forgetting = null; model.forget(state.host.id) }, enabled = !busy) { Text(stringResource(R.string.forget_host)) } },
            dismissButton = { TextButton({ forgetting = null }) { Text(stringResource(R.string.cancel)) } })
    }
}

@Composable
private fun DecisionsScreen(hosts: List<HostState>, open: (PendingDecision) -> Unit) {
    val pending = pendingDecisions(hosts)
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Section(stringResource(R.string.needs_you)) }
        if (pending.isEmpty()) item { Empty(R.string.no_decisions) }
        items(pending, key = { "${it.host.id}/${it.lane.slug}/${it.gate.name}" }) { decision ->
            Card(Modifier.fillMaxWidth().clickable { open(decision) }) {
                Column(Modifier.padding(16.dp)) {
                    Text(decision.gate.name, fontWeight = FontWeight.Bold)
                    Text(stringResource(R.string.decision_location, decision.host.name, decision.lane.slug))
                    val state = hosts.first { it.host.id == decision.host.id }
                    if (state.link != Link.Live) Text(stringResource(R.string.cached_at, state.desk!!.at), style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

@Composable
private fun ActivityScreen(state: HostState, model: AppModel) {
    val entries by model.activity.collectAsStateWithLifecycle()
    LaunchedEffect(state.host.id, state.desk?.at, state.link == Link.Live) { model.loadActivity() }
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (entries.isEmpty()) item { Empty(R.string.no_activity) }
        items(entries) { entry ->
            Card(Modifier.fillMaxWidth().clickable { model.openLane(entry.lane) }) {
                Column(Modifier.padding(12.dp)) {
                    Text(stringResource(R.string.activity_location, entry.at, entry.lane), style = MaterialTheme.typography.labelSmall)
                    Text(stringResource(R.string.ledger_entry, entry.kind, entry.text), style = FieldCode)
                }
            }
        }
    }
}

@Composable
private fun DeskScreen(desk: Desk, open: (String) -> Unit) {
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (desk.lanes.isEmpty() && desk.unreadable.isEmpty()) item { Empty(R.string.no_lanes) }
        items(desk.lanes, key = { it.slug }) { lane ->
            Card(Modifier.fillMaxWidth().clickable { open(lane.slug) }) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(lane.title, fontWeight = FontWeight.Bold)
                    Text(lane.slug, style = FieldCode)
                    Text(stringResource(when (lane.state) { LaneState.FINISHED -> R.string.finished; LaneState.BLOCKED -> R.string.blocked; LaneState.READY -> R.string.ready; LaneState.OPEN -> R.string.open }))
                    Text(stringResource(R.string.lane_progress, lane.process, lane.stageIndex + 1, lane.stageCount, lane.active.joinToString(", ").ifEmpty { lane.stage }))
                    if (lane.stageCount > 0) LinearProgressIndicator(progress = { ((lane.stageIndex + 1).toFloat() / lane.stageCount).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                    lane.gates.firstOrNull { !it.approved }?.let { Text(stringResource(R.string.needs_gate, it.name)) }
                    if (lane.openAlerts > 0) Text(stringResource(R.string.alert_count, lane.openAlerts))
                    lane.working?.let { Text(stringResource(R.string.working_since, it.engine, it.since)) }
                    lane.lastJob?.let { Text(stringResource(R.string.last_job, it.name, it.status)) }
                    if (lane.blockedBy.isNotEmpty()) Text(stringResource(R.string.blocked_by, lane.blockedBy.joinToString(", ")))
                    lane.lastNote?.let { Text(it.text, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                }
            }
        }
        items(desk.unreadable) { Text(stringResource(R.string.unreadable_lane, it.slug, it.error), color = MaterialTheme.colorScheme.error) }
        item { Text(stringResource(R.string.updated_at, desk.at), style = MaterialTheme.typography.labelSmall) }
        item { TelemetryView(desk.telemetry) }
    }
}

@Composable
private fun LaneScreen(lane: LaneDetail, state: HostState, model: AppModel, confirm: Confirm) {
    val busy by model.busy.collectAsStateWithLifecycle()
    val enabled = !busy && state.link == Link.Live
    var approving by remember(lane.slug, state.host.id) { mutableStateOf<GateView?>(null) }
    Column {
        Row {
            TextButton(model::closeLane) { Text(stringResource(R.string.back)) }
            TextButton(model::refreshLane, enabled = enabled) { Text(stringResource(R.string.refresh)) }
        }
        LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Text(lane.title, style = MaterialTheme.typography.titleLarge)
                Text(lane.slug, style = FieldCode)
                Text(stringResource(R.string.lane_kind, lane.process, lane.kind))
                lane.finished?.let { Text(stringResource(R.string.finished_at, it)) }
                lane.exit?.let { Text(stringResource(R.string.exit_when, it)) }
                lane.check?.let { Text(stringResource(R.string.check_command, it), style = FieldCode) }
            }
            item { Section(stringResource(R.string.stages)) }
            items(lane.stages) { stage ->
                val here = stage in lane.active || (lane.active.isEmpty() && stage == lane.stage && lane.finished == null)
                Text(stage, fontWeight = if (here) FontWeight.Bold else FontWeight.Normal,
                    color = if (here) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            }
            if (lane.gates.isNotEmpty()) item { Section(stringResource(R.string.gates)) }
            items(lane.gates) { gate ->
                val missing = gate.needs.filter { need -> lane.gates.none { it.name == need && it.approved } }
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text(gate.name, fontWeight = FontWeight.Bold)
                        Text(when {
                            gate.approved -> stringResource(R.string.approved_at, gate.approvedAt.orEmpty())
                            gate.policy -> stringResource(R.string.policy_gate)
                            missing.isNotEmpty() -> stringResource(R.string.needs_first, missing.joinToString(", "))
                            else -> stringResource(R.string.waiting_for, gate.owner)
                        })
                        if (!gate.approved && !gate.policy && gate.owner == state.host.person && missing.isEmpty() && lane.finished == null)
                            Button({ approving = gate }, enabled = enabled) { Text(stringResource(R.string.approve)) }
                    }
                }
            }
            if (lane.alerts.isNotEmpty()) item { Section(stringResource(R.string.alerts)) }
            items(lane.alerts) { alert ->
                Text(alert.message)
                Text(stringResource(if (alert.acknowledgedAt == null) R.string.open_since else R.string.acknowledged_at, alert.acknowledgedAt ?: alert.at), style = MaterialTheme.typography.bodySmall)
                if (alert.acknowledgedAt == null) OutlinedButton({
                    confirm(model.text(R.string.acknowledge_alert), model.text(R.string.action_summary, lane.slug, alert.message),
                        model.ackBody(lane.slug, alert.id), model.text(R.string.alert_acknowledged, alert.id))
                }, enabled = enabled) { Text(stringResource(R.string.acknowledge)) }
            }
            if (lane.humanTasks.isNotEmpty()) item { Section(stringResource(R.string.human_tasks)) }
            items(lane.humanTasks) { task ->
                Text(stringResource(R.string.task_status, task.stage, task.completedBy?.let { stringResource(R.string.completed_by, it) }
                    ?: task.assignee?.let { stringResource(R.string.assigned_to, it) } ?: stringResource(R.string.unclaimed)))
            }
            if (lane.notes.isNotEmpty()) item { Section(stringResource(R.string.notes)) }
            items(lane.notes.reversed()) { Text(stringResource(R.string.note_entry, it.at, it.stage, it.text)) }
            if (lane.ledger.isNotEmpty()) item { Section(stringResource(R.string.ledger)) }
            items(lane.ledger.reversed()) { Text(stringResource(R.string.log_entry, it.t, it.kind, it.text), style = FieldCode) }
        }
    }
    approving?.let { gate ->
        ApproveDialog(lane.slug, gate, enabled, { approving = null }) { quote ->
            approving = null
            if (model.isLive(state.host.id)) {
                val body = try { model.approveBody(lane.slug, gate.name, quote) }
                    catch (e: IllegalArgumentException) { model.report(model.describe(e)); return@ApproveDialog }
                confirm(model.text(R.string.approve_gate, gate.name), model.text(R.string.action_summary, lane.slug, quote.trim()), body, model.text(R.string.gate_approved, gate.name))
            }
        }
    }
}

@Composable
private fun ApproveDialog(slug: String, gate: GateView, enabled: Boolean, dismiss: () -> Unit, approve: (String) -> Unit) {
    var quote by rememberSaveable { mutableStateOf("") }
    AlertDialog(onDismissRequest = dismiss, title = { Text(stringResource(R.string.approve_gate, gate.name)) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.approval_words, slug))
            OutlinedTextField(quote, { quote = it }, label = { Text(stringResource(R.string.your_words)) }, minLines = 2)
        } },
        confirmButton = { Button({ approve(quote) }, enabled = enabled && quote.trim().length >= 2) { Text(stringResource(R.string.sign_send)) } },
        dismissButton = { TextButton(dismiss) { Text(stringResource(R.string.cancel)) } })
}

@Composable
private fun Section(title: String) {
    Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
    HorizontalDivider()
}

@Composable
private fun Empty(id: Int) { Text(stringResource(id), Modifier.padding(16.dp)) }

@Composable
private fun TelemetryView(t: Telemetry) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Section(stringResource(R.string.tokens_today, t.day))
        if (t.tokens.isEmpty()) Text(stringResource(R.string.none))
        t.tokens.forEach { Text(stringResource(R.string.token_row, it.lane, it.calls, it.input, it.output, it.usd)) }
        Section(stringResource(R.string.queue))
        t.queue.runners.forEach { Text(stringResource(R.string.runner_row, it.runner, it.waiting, it.running)) }
        Text(stringResource(R.string.queue_status, t.queue.failed, t.queue.unverified))
        Text(t.dispatcher?.let { stringResource(if (it.running) R.string.dispatcher_running else R.string.dispatcher_stopped, it.pid) } ?: stringResource(R.string.dispatcher_never))
        Section(stringResource(R.string.inbox, t.inbox.size))
        t.inbox.forEach { Text(stringResource(R.string.inbox_row, it.kind, it.from, it.project, it.summary)) }
        Section(stringResource(R.string.machines_today))
        if (t.machines.isEmpty()) Text(stringResource(R.string.none))
        t.machines.forEach { Text(stringResource(R.string.machine_row, it.lane, it.time, it.money.orEmpty())) }
        if (t.allowances.isNotEmpty()) Section(stringResource(R.string.allowances))
        t.allowances.forEach { Text(it, style = FieldCode) }
    }
}
