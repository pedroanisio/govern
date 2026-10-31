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
    val request by model.pairRequest.collectAsStateWithLifecycle()
    if (request != null) { PairRequestScreen(request!!, model); return }
    val busy by model.busy.collectAsStateWithLifecycle()
    val prefill by model.prefill.collectAsStateWithLifecycle()
    val input by model.pairInput.collectAsStateWithLifecycle()
    val error by model.pairError.collectAsStateWithLifecycle()
    var address by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var pin by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf(Build.MODEL.orEmpty()) }
    var manual by rememberSaveable { mutableStateOf(false) }
    var tls by rememberSaveable { mutableStateOf(false) }
    var scanning by remember { mutableStateOf(false) }
    var scanMessage by rememberSaveable { mutableStateOf<Int?>(null) }
    val context = androidx.compose.ui.platform.LocalContext.current
    val mode = pairMode(prefill, input)
    val enabled = !busy && !scanning
    BackHandler(canCancel && enabled) { model.cancelPairing() }
    LaunchedEffect(prefill) {
        prefill?.let { address = it.url; code = it.code; pin = it.pin.orEmpty(); scanMessage = null }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        PairTopBar(1, if (canCancel) model::cancelPairing else null, enabled)
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.pair_headline), style = MaterialTheme.typography.headlineLarge, color = PairGreen)
            Text(stringResource(R.string.pair_instructions), style = MaterialTheme.typography.bodyMedium)
        }
        PairIllustration(prefill?.url ?: stringResource(R.string.pair_host))
        Button({
            scanning = true
            scanMessage = null
            try {
                val options = com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions.Builder()
                    .setBarcodeFormats(com.google.mlkit.vision.barcode.common.Barcode.FORMAT_QR_CODE).build()
                com.google.mlkit.vision.codescanner.GmsBarcodeScanning.getClient(context, options).startScan()
                    .addOnSuccessListener { barcode -> scanning = false; model.offerLink(barcode.rawValue.orEmpty()) }
                    .addOnCanceledListener { scanning = false; scanMessage = R.string.scan_cancelled }
                    .addOnFailureListener { scanning = false; scanMessage = R.string.scan_failed }
            } catch (_: Exception) { scanning = false; scanMessage = R.string.scan_failed }
        }, Modifier.fillMaxWidth(), enabled = enabled) {
            if (scanning) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            else Text(stringResource(R.string.scan_qr))
        }
        scanMessage?.let { PairError(stringResource(it)) }
        if (mode == PairMode.SCANNED_LINK) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.pair_link), style = MaterialTheme.typography.titleSmall)
                    Text(prefill!!.url, style = FieldCode)
                    if (prefill!!.code.isNotEmpty()) Text(pairCode(prefill!!.code), style = FieldCode)
                    Text(stringResource(if (prefill!!.pin != null) R.string.pair_pin_present else R.string.pair_pin_absent), style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), enabled = enabled, label = { Text(stringResource(R.string.device_name)) }, singleLine = true)
                    PairSubmit(busy, enabled) { model.pair(prefill!!.url, prefill!!.code, prefill!!.pin.orEmpty(), name) }
                    error?.let { PairError(it) }
                    TextButton({ model.consumePrefill(); address = ""; code = ""; pin = ""; manual = false }, enabled = enabled) {
                        Text(stringResource(R.string.different_link))
                    }
                }
            }
        } else {
            if (mode == PairMode.SCANNED_INVALID) error?.let { PairError(it) }
            TextButton({ manual = !manual }, enabled = enabled) { Text(stringResource(R.string.enter_manually)) }
            if (manual) {
                OutlinedTextField(address, { address = it }, Modifier.fillMaxWidth(), enabled = enabled, label = { Text(stringResource(R.string.server_address)) }, singleLine = true)
                OutlinedTextField(code, { code = it }, Modifier.fillMaxWidth(), enabled = enabled, textStyle = FieldCode, label = { Text(stringResource(R.string.pair_code)) }, singleLine = true)
                OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), enabled = enabled, label = { Text(stringResource(R.string.device_name)) }, singleLine = true)
                TextButton({ tls = !tls }, enabled = enabled) { Text(stringResource(R.string.self_signed_tls)) }
                if (tls) OutlinedTextField(pin, { pin = it }, Modifier.fillMaxWidth(), enabled = enabled, textStyle = FieldCode, label = { Text(stringResource(R.string.certificate_pin)) }, singleLine = true)
                PairSubmit(busy, enabled && address.isNotBlank()) { model.pair(address, code, pin, name) }
                error?.let { PairError(it) }
            }
        }
        val placeholder = stringResource(R.string.pair_address_placeholder)
        val command = stringResource(R.string.pair_command, address.ifBlank { placeholder })
        Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceVariant) {
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(command, Modifier.weight(1f), style = FieldCode)
                TextButton({
                    val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    clipboard.setPrimaryClip(android.content.ClipData.newPlainText(context.getString(R.string.copy_command), command))
                }) { Text(stringResource(R.string.copy_command)) }
            }
        }
        Text(stringResource(R.string.pair_security), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun PairSubmit(busy: Boolean, enabled: Boolean, submit: () -> Unit) {
    Button(submit, Modifier.fillMaxWidth(), enabled = enabled) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
        }
        Text(stringResource(if (busy) R.string.pairing else R.string.pair))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Main(model: AppModel, state: HostState, confirm: Confirm) {
    val lane by model.lane.collectAsStateWithLifecycle()
    val hosts by model.hosts.collectAsStateWithLifecycle()
    val session by model.session.collectAsStateWithLifecycle()
    val decision by model.decision.collectAsStateWithLifecycle()
    val log by model.log.collectAsStateWithLifecycle()
    val newSession by model.newSession.collectAsStateWithLifecycle()
    val artifacts by model.artifacts.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableIntStateOf(0) }
    fun back() {
        when {
            log != null -> model.closeLog()
            artifacts -> model.showArtifacts(false)
            decision != null -> { model.closeDecision(); if (session == null) model.closeLane() }
            session != null || newSession -> { model.closeSession(); model.closeLane() }
            lane != null -> model.closeLane()
            else -> tab = 0
        }
    }
    BackHandler(lane != null || session != null || newSession || tab != 0) { back() }
    LaunchedEffect(state.desk?.at, state.host.id) { if (session != null) { model.refreshSession(); model.refreshLane() } }
    fun decide(d: PendingDecision) { model.selectHost(d.host.id); model.openLane(d.lane.slug); model.openDecision(d.gate.name) }
    val tabs = listOf(R.string.operation, R.string.hosts, R.string.decisions, R.string.activity)
    val icons = listOf(R.drawable.ic_operation, R.drawable.ic_hosts, R.drawable.ic_decisions, R.drawable.ic_activity)
    Scaffold(contentWindowInsets = WindowInsets(0, 0, 0, 0), bottomBar = {
        NavigationBar(windowInsets = WindowInsets(0, 0, 0, 0)) {
            tabs.forEachIndexed { index, label ->
                NavigationBarItem(selected = index == tab, onClick = { model.closeSession(); model.closeLane(); tab = index },
                    icon = { BadgedBox(badge = {
                        val count = pendingDecisions(hosts).size
                        if (index == 2 && showDecisionBadge(count)) Badge { Text(count.toString()) }
                    }) { Icon(painterResource(icons[index]), contentDescription = null) } },
                    label = { Text(stringResource(label)) })
            }
        }
    }) { pad ->
        Column(Modifier.padding(pad)) {
            TopAppBar(windowInsets = WindowInsets(0, 0, 0, 0), title = { Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(painterResource(R.drawable.ic_govern), contentDescription = null, tint = androidx.compose.ui.graphics.Color.Unspecified, modifier = Modifier.size(32.dp))
                Text(stringResource(R.string.wordmark))
                Text(stringResource(R.string.field_label), style = MaterialTheme.typography.labelSmall)
            } }, actions = {
                Surface(shape = androidx.compose.foundation.shape.CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                    Text(initials(state.host.person), Modifier.padding(12.dp))
                }
            })
            StatusBanner(state, if (lane != null) model.laneAt.collectAsStateWithLifecycle().value else null)
            val detail = lane
            when {
                log != null -> JobLogScreen(log!!, model::closeLog)
                newSession -> NewSessionScreen(hosts, state, model, confirm)
                decision != null && detail != null -> DecisionScreen(detail, decision!!, state, model, confirm)
                artifacts && detail != null -> ArtifactsScreen(detail, state, model, confirm)
                session != null -> SessionScreen(session!!, detail, state, model, confirm)
                detail != null -> LaneScreen(detail, state, model, confirm)
                else -> when (tab) {
                0 -> OperationScreen(hosts, model, ::decide)
                1 -> HostsScreen(hosts, state.host.id, model)
                2 -> FieldDecisionsScreen(hosts, model, ::decide)
                3 -> ActivityScreen(state, model)
                }
            }
        }
    }
}

@Composable
private fun StatusBanner(state: HostState, at: String? = null) {
    val banner = linkBanner(state.link, state.desk != null || at != null)
    if (banner == LinkBanner.NONE) return
    val label = when (banner) {
        LinkBanner.CACHED -> stringResource(R.string.cached_at, at ?: state.desk!!.at)
        LinkBanner.CONNECTING -> stringResource(R.string.connecting)
        LinkBanner.RETRYING -> (state.link as Link.Retrying).let { stringResource(R.string.retrying, it.seconds, it.reason) }
        else -> stringResource(R.string.offline)
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Surface(shape = androidx.compose.foundation.shape.CircleShape, color = MaterialTheme.colorScheme.secondaryContainer) {
            Text(label, Modifier.padding(horizontal = 12.dp, vertical = 4.dp), color = MaterialTheme.colorScheme.onSecondaryContainer)
        }

        when (val link = state.link) {
            is Link.Retrying -> if (banner == LinkBanner.CACHED) Text(stringResource(R.string.retrying, link.seconds, link.reason), style = MaterialTheme.typography.bodySmall)
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
        item { Button(model::beginPairing, enabled = !busy) { Text(stringResource(R.string.connect_session)) } }
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
private fun ActivityScreen(state: HostState, model: AppModel) {
    val entries by model.activity.collectAsStateWithLifecycle()
    LaunchedEffect(state.host.id, state.desk?.at, state.link == Link.Live) { model.loadActivity() }
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (entries.isEmpty()) item { Empty(R.string.no_activity) }
        activityGroups(entries, model.now(), java.time.ZoneId.systemDefault()).forEach { group ->
            item { ActivityDayHeading(group) }
            items(group.entries) { entry -> ActivityRow(entry) { model.openLane(entry.lane) } }
        }
    }
}

@Composable
private fun LaneScreen(lane: LaneDetail, state: HostState, model: AppModel, confirm: Confirm) {
    val busy by model.busy.collectAsStateWithLifecycle()
    val enabled = !busy && state.link == Link.Live
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
                lane.frozen?.let { FrozenBadge(it) }
                lane.importedFrom?.let { Text(stringResource(R.string.imported_from, it.slug, it.exportedAt), style = MaterialTheme.typography.bodySmall) }
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
                        if (!gate.approved && !gate.policy && gate.owner == state.host.person && missing.isEmpty() && lane.finished == null && lane.frozen == null)
                            Button({ model.openDecision(gate.name) }, enabled = enabled) { Text(stringResource(R.string.approve)) }
                    }
                }
            }
            if (lane.alerts.isNotEmpty()) item { Section(stringResource(R.string.alerts)) }
            items(lane.alerts) { alert ->
                Text(alert.message)
                Text(stringResource(if (alert.acknowledgedAt == null) R.string.open_since else R.string.acknowledged_at, alert.acknowledgedAt ?: alert.at), style = MaterialTheme.typography.bodySmall)
                if (alert.acknowledgedAt == null && lane.frozen == null) OutlinedButton({
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
            activityGroups(lane.ledger.map { ActivityEntry(lane.slug, it.t, it.kind, it.text, it.summary, it.tone) }, model.now(), java.time.ZoneId.systemDefault()).forEach { group ->
                item { ActivityDayHeading(group) }
                items(group.entries) { ActivityRow(it) }
            }
        }
    }
}

@Composable
fun FrozenBadge(frozen: FrozenView) {
    Surface(shape = androidx.compose.foundation.shape.CircleShape, color = MaterialTheme.colorScheme.errorContainer) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) {
            Text(stringResource(R.string.frozen_badge, frozen.at, frozen.quote), color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodySmall)
            frozen.continuedAs?.let { Text(stringResource(R.string.frozen_continued_as, it), color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodySmall) }
        }
    }
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

@Composable
private fun ActivityDayHeading(group: ActivityGroup) {
    Text(when (group.day) {
        ActivityDay.TODAY -> stringResource(R.string.today)
        ActivityDay.YESTERDAY -> stringResource(R.string.yesterday)
        ActivityDay.DATE -> group.date!!.format(java.time.format.DateTimeFormatter.ofLocalizedDate(java.time.format.FormatStyle.MEDIUM))
        ActivityDay.UNDATED -> stringResource(R.string.undated)
    }, style = MaterialTheme.typography.titleSmall)
}

@Composable
private fun ActivityRow(entry: ActivityEntry, open: (() -> Unit)? = null) {
    val tone = when (activityTone(entry.tone)) {
        ActivityTone.OK -> FieldSuccess
        ActivityTone.FAILED -> MaterialTheme.colorScheme.error
        ActivityTone.RUNNING -> FieldWarning
        ActivityTone.INFO -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Card(Modifier.fillMaxWidth().then(if (open != null) Modifier.clickable(onClick = open) else Modifier)) {
        Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Surface(Modifier.padding(top = 6.dp).size(8.dp), shape = androidx.compose.foundation.shape.CircleShape, color = tone) {}
            Column {
                Text(activitySummary(entry, stringResource(R.string.command_set), stringResource(R.string.activity_job), stringResource(R.string.activity_check)), style = MaterialTheme.typography.bodyMedium)
                Text(stringResource(R.string.activity_location, activityTime(entry.at, java.time.ZoneId.systemDefault()), entry.lane), style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}
