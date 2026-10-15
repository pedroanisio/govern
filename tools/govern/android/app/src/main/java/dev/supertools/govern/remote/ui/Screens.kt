package dev.supertools.govern.remote.ui

import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.supertools.govern.remote.protocol.AlertView
import dev.supertools.govern.remote.protocol.Desk
import dev.supertools.govern.remote.protocol.GateView
import dev.supertools.govern.remote.protocol.LaneDetail
import dev.supertools.govern.remote.protocol.LaneState
import dev.supertools.govern.remote.protocol.LaneSummary
import dev.supertools.govern.remote.protocol.Telemetry
import dev.supertools.govern.remote.security.PairedServer

/** Asks the person to confirm and sign: (title, summary, body to sign, message on success). */
typealias Confirm = (String, String, ByteArray, String) -> Unit

@Composable
fun App(model: AppModel, confirm: Confirm) {
    val dark = isSystemInDarkTheme()
    MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
        Surface(Modifier.fillMaxSize()) {
            val paired by model.paired.collectAsStateWithLifecycle()
            val message by model.message.collectAsStateWithLifecycle()
            val snack = remember { SnackbarHostState() }
            LaunchedEffect(message) {
                message?.let { snack.showSnackbar(it); model.consumeMessage() }
            }
            Scaffold(snackbarHost = { SnackbarHost(snack) }) { pad ->
                Column(Modifier.padding(pad)) {
                    val p = paired
                    if (p == null) PairScreen(model) else Main(model, p, confirm)
                }
            }
        }
    }
}

@Composable
private fun PairScreen(model: AppModel) {
    val busy by model.busy.collectAsStateWithLifecycle()
    var address by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var pin by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf(Build.MODEL ?: "Android") }
    val prefill by model.prefill.collectAsStateWithLifecycle()
    // A scanned link fills each field on its own, so the server address stays in view before the person taps Pair.
    LaunchedEffect(prefill) {
        prefill?.let { address = it.url; code = it.code; pin = it.pin ?: ""; model.consumePrefill() }
    }
    val isLink = address.trim().startsWith("govern-remote:")
    Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Pair with govern", style = MaterialTheme.typography.headlineSmall)
        Text("At your own terminal, run: govern remote pair --url <address the phone reaches>. Scan the QR code it draws with " +
            "this phone's camera, or paste the pairing link it prints, or type the address and the code.", style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(address, { address = it }, Modifier.fillMaxWidth(), label = { Text("Pairing link or server address") }, singleLine = true)
        if (!isLink) {
            OutlinedTextField(code, { code = it }, Modifier.fillMaxWidth(), label = { Text("Pairing code") }, singleLine = true)
            OutlinedTextField(pin, { pin = it }, Modifier.fillMaxWidth(), label = { Text("Certificate pin (self-signed TLS only)") }, singleLine = true)
        }
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("This device's name") }, singleLine = true)
        Button({ model.pair(address, code, pin, name) }, enabled = !busy && address.isNotBlank()) { Text(if (busy) "Pairing…" else "Pair") }
        Text("Pairing creates a key in this phone's secure hardware. Every approval you send is signed with it after you confirm " +
            "with your fingerprint or screen lock.", style = MaterialTheme.typography.bodySmall)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Main(model: AppModel, paired: PairedServer, confirm: Confirm) {
    val desk by model.desk.collectAsStateWithLifecycle()
    val link by model.link.collectAsStateWithLifecycle()
    val lane by model.lane.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var menu by remember { mutableStateOf(false) }
    val open = lane
    if (open != null) {
        BackHandler { model.closeLane() }
        LaneScreen(open, paired, model, confirm)
        return
    }
    Column {
        TopAppBar(
            title = {
                Column {
                    Text("govern")
                    Text(linkText(link), style = MaterialTheme.typography.labelSmall)
                }
            },
            actions = { TextButton({ menu = true }) { Text("Device") } },
        )
        TabRow(selectedTabIndex = tab) {
            Tab(tab == 0, { tab = 0 }, text = { Text("Lanes") })
            Tab(tab == 1, { tab = 1 }, text = { Text("Telemetry") })
        }
        val d = desk
        when {
            d == null -> Text("Waiting for the desk…", Modifier.padding(16.dp))
            tab == 0 -> LanesList(d, model::openLane)
            else -> TelemetryView(d.telemetry)
        }
    }
    if (menu) AlertDialog(
        onDismissRequest = { menu = false },
        title = { Text("This device") },
        text = {
            Text("Server ${paired.baseUrl}\nDevice ${paired.deviceId}\nApproves as ${paired.person}" +
                (paired.pin?.let { "\nPinned certificate ${it.take(16)}…" } ?: ""))
        },
        confirmButton = { TextButton({ menu = false }) { Text("Close") } },
        dismissButton = { TextButton({ menu = false; model.unpair() }) { Text("Unpair") } },
    )
}

private fun linkText(l: Link): String = when (l) {
    Link.Connecting -> "connecting…"
    Link.Live -> "live"
    is Link.Retrying -> "retrying in ${l.seconds}s: ${l.reason}"
    is Link.Stopped -> l.reason
}

@Composable
private fun LanesList(d: Desk, open: (String) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (d.lanes.isEmpty() && d.unreadable.isEmpty()) item { Text("No lanes yet.") }
        items(d.lanes, key = { it.slug }) { LaneCard(it) { open(it.slug) } }
        items(d.unreadable, key = { "x-" + it.slug }) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                Column(Modifier.padding(12.dp)) {
                    Text(it.slug, fontWeight = FontWeight.Bold)
                    Text("unreadable: ${it.error}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        item { Text("updated ${d.at.take(19).replace('T', ' ')} UTC", style = MaterialTheme.typography.labelSmall) }
    }
}

/** The first gate not approved yet, as the desk shows it. */
private fun pendingGate(gates: List<GateView>): GateView? = gates.firstOrNull { !it.approved }

@Composable
private fun LaneCard(l: LaneSummary, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(l.slug, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                StateChip(l.state)
            }
            if (l.title != l.slug) Text(l.title, style = MaterialTheme.typography.bodySmall)
            Text("${l.process} · stage ${l.stageIndex + 1}/${l.stageCount} ${l.active.joinToString(", ").ifEmpty { l.stage }}",
                style = MaterialTheme.typography.bodyMedium)
            if (l.stageCount > 0) LinearProgressIndicator(progress = { (l.stageIndex + 1).toFloat() / l.stageCount }, modifier = Modifier.fillMaxWidth())
            val g = pendingGate(l.gates)
            val facts = listOfNotNull(
                g?.let { "needs ${it.name}" } ?: if (l.gates.isNotEmpty()) "all approved" else null,
                if (l.openAlerts > 0) "${l.openAlerts} alert${if (l.openAlerts == 1) "" else "s"}" else null,
                l.working?.let { "● ${it.engine} since ${it.since.take(16).replace('T', ' ')}" },
                l.lastJob?.let { "job ${it.name} ${it.status}" },
                if (l.blockedBy.isNotEmpty()) "blocked by ${l.blockedBy.joinToString(", ")}" else null,
            )
            if (facts.isNotEmpty()) Text(facts.joinToString(" · "), style = MaterialTheme.typography.labelMedium)
            l.lastNote?.let { Text(it.text, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
    }
}

@Composable
private fun StateChip(s: LaneState) {
    val text = when (s) { LaneState.FINISHED -> "finished"; LaneState.BLOCKED -> "blocked"; LaneState.READY -> "ready"; LaneState.OPEN -> "open" }
    AssistChip(onClick = {}, label = { Text(text) })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LaneScreen(l: LaneDetail, paired: PairedServer, model: AppModel, confirm: Confirm) {
    var approving by remember { mutableStateOf<GateView?>(null) }
    val busy by model.busy.collectAsStateWithLifecycle()
    Column {
        TopAppBar(
            title = { Text(l.slug, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { TextButton(model::closeLane) { Text("Back") } },
            actions = { TextButton(model::refreshLane) { Text("Refresh") } },
        )
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            item {
                Text(l.title, style = MaterialTheme.typography.titleMedium)
                Text("${l.process} · ${l.kind}${l.finished?.let { " · finished ${it.take(10)}" } ?: ""}", style = MaterialTheme.typography.bodySmall)
                l.exit?.let { Text("exit when: $it", style = MaterialTheme.typography.bodySmall) }
                l.check?.let { Text("check: $it", style = MaterialTheme.typography.bodySmall) }
            }
            item { Section("Stages") }
            items(l.stages) { s ->
                val here = s in l.active || (l.active.isEmpty() && s == l.stage && l.finished == null)
                val done = l.stages.indexOf(s) < l.stageIndex || l.finished != null
                Text((if (here) "▶ " else if (done) "✓ " else "· ") + s, fontWeight = if (here) FontWeight.Bold else FontWeight.Normal)
            }
            if (l.gates.isNotEmpty()) {
                item { Section("Gates") }
                items(l.gates, key = { "g-" + it.name }) { g -> GateRow(g, l.gates, paired.person, busy) { approving = g } }
            }
            if (l.alerts.isNotEmpty()) {
                item { Section("Alerts") }
                items(l.alerts, key = { "a-" + it.id }) { a ->
                    AlertRow(a, busy) {
                        confirm("Acknowledge alert", "${l.slug}: ${a.message}", model.ackBody(l.slug, a.id), "alert ${a.id} acknowledged")
                    }
                }
            }
            if (l.humanTasks.isNotEmpty()) {
                item { Section("Human tasks") }
                items(l.humanTasks) { t -> Text("${t.stage}: ${t.completedBy?.let { "completed by $it" } ?: t.assignee?.let { "assigned to $it" } ?: "unclaimed"}") }
            }
            if (l.notes.isNotEmpty()) {
                item { Section("Decisions") }
                items(l.notes.reversed()) { n -> Text("${n.at.take(16).replace('T', ' ')} [${n.stage}] ${n.text}", style = MaterialTheme.typography.bodySmall) }
            }
            if (l.ledger.isNotEmpty()) {
                item { Section("Ledger") }
                items(l.ledger.reversed()) { e ->
                    Text("${e.t.take(16).replace('T', ' ')} ${e.kind} ${e.text}", style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
    approving?.let { g ->
        ApproveDialog(l.slug, g, onDismiss = { approving = null }) { quote ->
            approving = null
            val body = try { model.approveBody(l.slug, g.name, quote) } catch (e: IllegalArgumentException) { model.report(e.message ?: "invalid"); return@ApproveDialog }
            confirm("Approve ${g.name}", "${l.slug}: \"${quote.trim()}\"", body, "${g.name} approved")
        }
    }
}

@Composable
private fun Section(title: String) {
    Spacer(Modifier.height(8.dp))
    Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
    HorizontalDivider()
}

@Composable
private fun GateRow(g: GateView, all: List<GateView>, person: String, busy: Boolean, approve: () -> Unit) {
    val missing = g.needs.filter { n -> all.firstOrNull { it.name == n }?.approved != true }
    val why = when {
        g.approved -> "approved ${g.approvedAt?.take(16)?.replace('T', ' ') ?: ""}"
        g.policy -> "decided by an approval policy: at a terminal"
        g.owner != person -> "decided by ${g.owner}"
        missing.isNotEmpty() -> "needs ${missing.joinToString(", ")} first"
        else -> null
    }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text((if (g.approved) "✓ " else "") + g.name, fontWeight = FontWeight.Medium)
            Text(why ?: "waiting for ${g.owner}${g.stage?.let { " · at $it" } ?: ""}", style = MaterialTheme.typography.bodySmall)
        }
        if (why == null) Button(approve, enabled = !busy) { Text("Approve") }
    }
}

@Composable
private fun AlertRow(a: AlertView, busy: Boolean, ack: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.weight(1f)) {
            Text("${a.kind} · ${a.stage}", fontWeight = FontWeight.Medium)
            Text(a.message, style = MaterialTheme.typography.bodySmall)
            Text(a.acknowledgedAt?.let { "acknowledged ${it.take(16).replace('T', ' ')}" } ?: "open since ${a.at.take(16).replace('T', ' ')}",
                style = MaterialTheme.typography.labelSmall)
        }
        if (a.acknowledgedAt == null) OutlinedButton(ack, enabled = !busy) { Text("Ack") }
    }
}

@Composable
private fun ApproveDialog(slug: String, g: GateView, onDismiss: () -> Unit, onApprove: (String) -> Unit) {
    var quote by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Approve ${g.name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("$slug. Type your own words: govern records them as your approval, signed by this phone.")
                OutlinedTextField(quote, { quote = it }, Modifier.fillMaxWidth(), label = { Text("Your words") }, minLines = 2)
            }
        },
        confirmButton = { Button({ onApprove(quote) }, enabled = quote.trim().length >= 2) { Text("Sign and send") } },
        dismissButton = { TextButton(onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun TelemetryView(t: Telemetry) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item { Section("Tokens today (${t.day}) · queue runs and codex asks") }
        if (t.tokens.isEmpty()) item { Text("none") }
        items(t.tokens) { r ->
            Row(Modifier.fillMaxWidth()) {
                Text(r.lane, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${r.calls} runs · ${kTok(r.input)} in · ${kTok(r.output)} out${if (r.usd > 0) " · $%.2f".format(r.usd) else ""}",
                    style = MaterialTheme.typography.bodySmall)
            }
        }
        item { Section("Queue") }
        items(t.queue.runners) { r -> Text("${r.runner}: ${r.waiting} waiting, ${r.running} running") }
        item {
            Text("failed ${t.queue.failed} · unverified replies ${t.queue.unverified}")
            Text(t.dispatcher?.let { if (it.running) "dispatcher running (pid ${it.pid}, every ${it.interval}s)" else "dispatcher NOT running (pid ${it.pid} gone)" }
                ?: "dispatcher never started")
        }
        item { Section("Your inbox (${t.inbox.size})") }
        items(t.inbox) { m -> Text("${m.kind} from ${m.from} [${m.project}] ${m.summary}", style = MaterialTheme.typography.bodySmall) }
        item { Section("Machines today") }
        if (t.machines.isEmpty()) item { Text("none") }
        items(t.machines) { m -> Text("${m.lane}: ${m.time}${m.money?.let { " · $it" } ?: ""}") }
        if (t.allowances.isNotEmpty()) {
            item { Section("Allowances") }
            items(t.allowances) { a -> Text(a, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
        }
        item { Spacer(Modifier.width(1.dp).height(24.dp)) }
    }
}

private fun kTok(n: Long): String = when {
    n >= 1_000_000 -> "%.2fM".format(n / 1e6)
    n >= 1_000 -> "${Math.round(n / 1e3)}k"
    else -> n.toString()
}
