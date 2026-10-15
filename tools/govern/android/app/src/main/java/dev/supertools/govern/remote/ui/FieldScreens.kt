package dev.supertools.govern.remote.ui

import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.border
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.supertools.govern.remote.R
import dev.supertools.govern.remote.protocol.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

private val DecisionGreen = Color(0xFF1E3A2C)
private val DecisionLime = Color(0xFFD9F26A)

@Composable
fun OperationScreen(hosts: List<HostState>, model: AppModel, decide: (PendingDecision) -> Unit) {
    LaunchedEffect(hosts.map { it.host.id to it.desk?.at }) { model.loadDecisionEvidence() }
    val overview = overview(hosts)
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column {
                    Text(stringResource(R.string.operation), style = MaterialTheme.typography.headlineLarge)
                    Text(stringResource(R.string.overview_subtitle,
                        pluralStringResource(R.plurals.session_count, overview.sessions, overview.sessions),
                        pluralStringResource(R.plurals.decision_count, overview.decisions, overview.decisions)))
                }
                FilledTonalButton(model::beginSession, enabled = hosts.any { it.link == Link.Live }) { Text(stringResource(R.string.add_session)) }
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(stringResource(R.string.hosts_label), style = MaterialTheme.typography.labelLarge)
                Text(stringResource(R.string.host_counts, overview.online, overview.offline), style = MaterialTheme.typography.labelSmall)
            }
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                hosts.forEach { state ->
                    Card(Modifier.widthIn(min = 104.dp).clickable { model.selectHost(state.host.id) }) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                Surface(Modifier.size(6.dp), shape = CircleShape, color = if (state.link == Link.Live) FieldSuccess else MaterialTheme.colorScheme.onSurfaceVariant) {}
                                Text(state.host.name, style = MaterialTheme.typography.titleSmall)
                            }
                            Text(if (state.link == Link.Live) pluralStringResource(R.plurals.session_count, state.desk?.sessions?.size ?: 0, state.desk?.sessions?.size ?: 0)
                                else stringResource(R.string.cached), style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
        item { NeedsHeading(overview.decisions) }
        items(pendingDecisions(hosts), key = { "${it.host.id}/${it.lane.slug}/${it.gate.name}" }) { decision ->
            DecisionCard(decision, hosts.first { it.host.id == decision.host.id }, model, hosts.size > 1) { decide(decision) }
        }
        item { Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(stringResource(R.string.sessions), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.all_sessions, overview.sessions), style = MaterialTheme.typography.labelLarge)
        } }
        if (overview.sessions == 0) item { Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.no_sessions), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.no_sessions_hint))
                Button(model::beginSession, enabled = hosts.any { it.link == Link.Live }) { Text(stringResource(R.string.new_session)) }
            }
        } }
        items(sessionRows(hosts), key = { "${it.host.host.id}/${it.session.id}" }) { row ->
            Card(Modifier.fillMaxWidth().clickable { model.openSession(row.host.host, row.session) }) {
                Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Surface(shape = CircleShape, color = MaterialTheme.colorScheme.secondaryContainer) { Text(initials(row.session.title), Modifier.padding(12.dp)) }
                    Column {
                        Text(row.session.title, fontWeight = FontWeight.Bold)
                        Text(stringResource(R.string.session_location, row.session.engine, row.host.host.name))
                        val state = sessionState(row.session, row.host.link == Link.Live)
                        Text(stringResource(sessionStateString(state)), color = if (state == SessionState.DECISION) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

private fun sessionStateString(state: SessionState): Int = when (state) {
    SessionState.OFFLINE -> R.string.host_offline
    SessionState.DECISION -> R.string.your_decision
    SessionState.RUNNING -> R.string.running
    SessionState.QUEUED -> R.string.queued
    SessionState.FAILED -> R.string.failed
    SessionState.CLOSED -> R.string.closed
    SessionState.IDLE -> R.string.idle
}

@Composable
fun FieldDecisionsScreen(hosts: List<HostState>, model: AppModel, open: (PendingDecision) -> Unit) {
    LaunchedEffect(hosts.map { it.host.id to it.desk?.at }) { model.loadDecisionEvidence() }
    val pending = pendingDecisions(hosts)
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { NeedsHeading(pending.size) }
        if (pending.isEmpty()) item { Text(stringResource(R.string.no_decisions)) }
        items(pending, key = { "${it.host.id}/${it.lane.slug}/${it.gate.name}" }) { decision ->
            DecisionCard(decision, hosts.first { it.host.id == decision.host.id }, model, hosts.size > 1) { open(decision) }
        }
    }
}

@Composable
private fun NeedsHeading(count: Int) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.needs_you), style = MaterialTheme.typography.titleMedium)
        Surface(shape = CircleShape, color = DecisionLime, contentColor = DecisionGreen) { Text(countPill(count), Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) }
    }
}

@Composable
private fun DecisionCard(decision: PendingDecision, state: HostState, model: AppModel, showHost: Boolean, open: () -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = DecisionGreen, contentColor = Color.White)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(stringResource(R.string.ready_review), color = DecisionLime, style = MaterialTheme.typography.labelMedium)
                if (showHost) Text(state.host.name, style = MaterialTheme.typography.labelSmall)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(decision.lane.title, style = MaterialTheme.typography.titleLarge)
                    Text(gateSubtitle(decision.gate.name, decision.lane.stage, stringResource(R.string.gate_subtitle)), style = MaterialTheme.typography.bodySmall)
                }
                val detail = state.cachedLanes[decision.lane.slug]?.detail
                latestArtifact(detail?.artifacts.orEmpty().filter { it.mediaType.startsWith("image/") || it.mediaType.startsWith("video/") })?.let {
                    ArtifactPreview(state, decision.lane.slug, it, model, Modifier.size(64.dp).clip(RoundedCornerShape(8.dp)))
                }
            }
            ChecksSummary(decision.lane.checkSummary)
            Button(open, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.buttonColors(containerColor = DecisionLime, contentColor = DecisionGreen)) { Text(stringResource(R.string.review_decision)) }
        }
    }
}

@Composable
private fun ChecksSummary(checks: CheckSummary) {
    val choice = checksLine(checks.passed, checks.total, checks.failed)
    val text = androidx.compose.ui.text.buildAnnotatedString {
        append(stringResource(when (choice) {
            ChecksLine.NONE -> R.string.no_checks
            ChecksLine.ALL -> R.string.passed_checks
            else -> R.string.partial_checks
        }, checks.passed, checks.total))
        if (choice == ChecksLine.FAILED) {
            pushStyle(androidx.compose.ui.text.SpanStyle(color = MaterialTheme.colorScheme.error))
            append(stringResource(R.string.failed_checks, checks.failed))
            pop()
        }
    }
    Text(text, style = MaterialTheme.typography.bodySmall)
}

@Composable
fun SessionScreen(detail: SessionDetail, lane: LaneDetail?, state: HostState, model: AppModel, confirm: Confirm) {
    val busy by model.busy.collectAsStateWithLifecycle()
    val session = detail.session
    val control = canControl(state.desk?.viewer?.lanes ?: state.host.lanes, session.lane)
    val enabled = !busy && state.link == Link.Live && control && session.state != "closed"
    var message by rememberSaveable(state.host.id, session.id) { mutableStateOf("") }
    var interrupt by rememberSaveable(state.host.id, session.id) { mutableStateOf(false) }
    val gate = lane?.gates?.firstOrNull { awaitsDecision(it, lane.stage, lane.state, state.host.person) }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            TextButton({ model.closeSession(); model.closeLane() }) { Text(stringResource(R.string.back)) }
            Text(session.title, style = MaterialTheme.typography.headlineMedium)
            Text(stringResource(R.string.session_breadcrumb, state.host.name, session.engine, session.id), style = FieldCode)
            if (showLiveControl(state.link, control)) Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceVariant) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Surface(Modifier.size(6.dp), shape = CircleShape, color = FieldSuccess) {}
                    Text(stringResource(R.string.live_control), style = MaterialTheme.typography.labelMedium)
                }
            }
            TextButton({ model.refreshSession(); model.refreshLane() }, enabled = state.link == Link.Live) { Text(stringResource(R.string.refresh)) }
        }
        if (lane != null) {
            item {
                Row(Modifier.fillMaxWidth()) {
                    stageSteps(lane).forEachIndexed { index, step ->
                        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                HorizontalDivider(Modifier.weight(1f), color = if (index == 0) Color.Transparent else MaterialTheme.colorScheme.outlineVariant)
                                Surface(Modifier.size(28.dp).border(2.dp, if (step.state == StageState.CURRENT) DecisionLime else DecisionGreen, CircleShape),
                                    shape = CircleShape, color = if (step.state == StageState.DONE) DecisionGreen else MaterialTheme.colorScheme.surface) {
                                    Box(contentAlignment = Alignment.Center) { if (step.state == StageState.DONE) Text("✓", color = DecisionLime) }
                                }
                                HorizontalDivider(Modifier.weight(1f), color = if (index == lane.stages.lastIndex) Color.Transparent else MaterialTheme.colorScheme.outlineVariant)
                            }
                            Text(step.name, style = MaterialTheme.typography.labelSmall, fontWeight = if (step.state == StageState.CURRENT) FontWeight.Bold else FontWeight.Normal)
                        }
                    }
                }
                Text(lane.stage, style = MaterialTheme.typography.titleLarge)
                gate?.let { Text(stringResource(R.string.gate_waits, it.name)) }
            }
            latestArtifact(lane.artifacts)?.let { artifact -> item { ArtifactCard(lane.slug, artifact, state, model, confirm, false) } }
            lane.jobs.firstOrNull()?.let { job ->
                item {
                    Card(colors = CardDefaults.cardColors(containerColor = DecisionGreen, contentColor = DecisionLime)) {
                        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(stringResource(R.string.job_heading, shortJobId(job.id), jobStatus(job.status)), style = FieldCode)
                            Text(job.name, style = MaterialTheme.typography.titleMedium)
                            job.progress?.let { progress ->
                                Text(stringResource(R.string.job_progress, progress.done, progress.total))
                                if (progress.total > 0) LinearProgressIndicator(progress = { (progress.done.toFloat() / progress.total).coerceIn(0f, 1f) })
                            }
                            Text(stringResource(R.string.job_checks, lane.checks.count { it.job == job.id && it.ok }, job.exit?.toString() ?: "—"))
                            TextButton({ model.openLog(lane.slug, job.id) }) { Text(stringResource(R.string.full_log), color = DecisionLime) }
                        }
                    }
                }
            }
        }
        detail.messages.lastOrNull()?.let { last -> item {
            Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.last_message), style = MaterialTheme.typography.labelLarge)
            Text(stringResource(R.string.message_age, session.engine, ageMinutes(last.at, model.now())))
            if (unverified(last)) Text(stringResource(R.string.unverified), color = MaterialTheme.colorScheme.error)
            SelectionContainer { Text(last.text) }
            } }
        } }
        detail.runs.lastOrNull()?.let { run -> item {
            Text(stringResource(R.string.run_state, run.id, run.state), style = FieldCode)
            run.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        } }
        if (gate != null) item { Button({ model.openDecision(gate.name) }, enabled = enabled) { Text(stringResource(R.string.review_publication)) } }
        item {
            Text(stringResource(R.string.message_label), style = MaterialTheme.typography.labelLarge)
            OutlinedTextField(message, { if (it.length <= 8000) message = it }, Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.instruct_hint, session.engine)) }, minLines = 2)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(interrupt, { interrupt = it }, enabled = enabled)
                Text(stringResource(R.string.interrupt))
            }
            Text(stringResource(if (interrupt) R.string.interrupt_hint else R.string.queue_hint))
            Button({ confirm(model.text(R.string.send_instruction), message,
                Actions.instruct(session.id, message, if (interrupt) "interrupt" else "queue"), model.text(R.string.instruction_sent)) },
                enabled = enabled && message.trim().isNotEmpty()) { Text(stringResource(R.string.send)) }
        }
        if (lane != null) item {
            Row(Modifier.fillMaxWidth()) {
                TextButton({ lane.jobs.firstOrNull()?.let { model.openLog(lane.slug, it.id) } }, enabled = lane.jobs.isNotEmpty(), modifier = Modifier.weight(1f)) { Text(stringResource(R.string.logs)) }
                TextButton({ model.showArtifacts(true) }, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.artifacts)) }
                TextButton({ model.closeSession() }, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.more_actions)) }
            }
        }
    }
}

@Composable
fun DecisionScreen(lane: LaneDetail, gateName: String, state: HostState, model: AppModel, confirm: Confirm) {
    val busy by model.busy.collectAsStateWithLifecycle()
    val artifact = latestArtifact(lane.artifacts)
    var quote by rememberSaveable(state.host.id, lane.slug, gateName, artifact?.sha256) { mutableStateOf("") }
    val enabled = canDecide(lane, gateName, state.host.person, state.host.lanes, state.link == Link.Live, busy, quote)
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            TextButton({ model.closeDecision(); if (model.session.value == null) model.closeLane() }) { Text(stringResource(R.string.back)) }
            Text(stringResource(R.string.decision_gate, gateName), style = MaterialTheme.typography.headlineMedium)
            Text(stringResource(R.string.decision_location, state.host.name, lane.slug), style = FieldCode)
            Text(stringResource(R.string.approve_version), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(if (artifact != null) R.string.applies_artifact else R.string.no_artifact))
        }
        if (artifact != null) item { ArtifactCard(lane.slug, artifact, state, model, confirm, true) }
        item { Text(stringResource(R.string.evidence_count, lane.checkSummary.passed, lane.checkSummary.total), style = MaterialTheme.typography.titleLarge) }
        items(evidenceRows(lane)) { evidence ->
            ListItem(modifier = Modifier.clickable(enabled = evidence.job != null && state.link == Link.Live) { evidence.job?.let { model.openLog(lane.slug, it) } },
                headlineContent = { Text(stringResource(R.string.evidence_row, evidence.stage, evidence.name)) },
                leadingContent = { Text(if (evidence.passed) "✓" else "✕", color = if (evidence.passed) FieldSuccess else MaterialTheme.colorScheme.error) },
                trailingContent = { Text("→") })
            HorizontalDivider()
        }
        item {
            Text(stringResource(R.string.record_decision), style = MaterialTheme.typography.titleLarge)
            Text(stringResource(R.string.person_owner, state.host.person))
            OutlinedTextField(quote, { if (it.length <= 2000) quote = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.your_words)) }, minLines = 3)
            Text(stringResource(R.string.human_approval), Modifier.padding(top = 16.dp), style = MaterialTheme.typography.labelLarge)
            Button({ confirm(model.text(R.string.approve_gate, gateName), quote,
                Actions.approve(lane.slug, gateName, quote, artifact?.let { ArtifactRef(it.name, it.sha256) }), model.text(R.string.gate_approved, gateName)) },
                enabled = enabled, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.confirm_approval)) }
            OutlinedButton({ confirm(model.text(R.string.request_changes), quote,
                Actions.changes(lane.slug, gateName, quote, artifact?.let { ArtifactRef(it.name, it.sha256) }), model.text(R.string.changes_sent)) },
                enabled = enabled, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.request_changes)) }
            Text(stringResource(R.string.approval_footer), style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun ArtifactCard(slug: String, artifact: ArtifactView, state: HostState, model: AppModel, confirm: Confirm, review: Boolean) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (review) ArtifactPreview(state, slug, artifact, model)
            Text(stringResource(if (review) R.string.artifact_lane_version else R.string.artifact_version, if (review) slug else stringResource(R.string.artifact_label), artifact.version), style = MaterialTheme.typography.labelLarge)
            artifact.title?.let { Text(it, style = MaterialTheme.typography.titleLarge) }
            artifact.caption?.let { Text(it) }
            Text(artifact.name)
            Text(stringResource(R.string.artifact_metadata, artifact.bytes, artifact.mediaType), style = FieldCode)
            Text(stringResource(R.string.artifact_sha, shortDigest(artifact.sha256)), style = FieldCode)
            if (!review) ArtifactPreview(state, slug, artifact, model)
            if (reviewedBy(artifact, state.host.person)) Text(stringResource(R.string.reviewed_you))
            Button({ model.openArtifact(slug, artifact, review, confirm) }, enabled = state.link == Link.Live) {
                Text(stringResource(if (artifact.mediaType.startsWith("video/")) R.string.open_video else R.string.open_file))
            }
        }
    }
}

@Composable
private fun ArtifactPreview(state: HostState, slug: String, artifact: ArtifactView, model: AppModel, modifier: Modifier = Modifier.fillMaxWidth().height(220.dp)) {
    if (!artifact.mediaType.startsWith("image/") && !artifact.mediaType.startsWith("video/")) return
    var bitmap by remember(state.host.id, slug, artifact.sha256) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(state.host.id, slug, artifact.sha256, state.link == Link.Live) {
        if (state.link != Link.Live) return@LaunchedEffect
        try {
            val file = model.download(state.host, slug, artifact)
            bitmap = withContext(Dispatchers.IO) {
                if (artifact.mediaType.startsWith("video/")) {
                    val retriever = MediaMetadataRetriever()
                    try { retriever.setDataSource(file.absolutePath); retriever.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 640, 360)?.asImageBitmap() }
                    finally { retriever.release() }
                } else {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(file.absolutePath, bounds)
                    val sample = BitmapFactory.Options().apply { inSampleSize = (maxOf(bounds.outWidth, bounds.outHeight) / 1024).coerceAtLeast(1) }
                    BitmapFactory.decodeFile(file.absolutePath, sample)?.asImageBitmap()
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: Exception) { model.report(model.describe(e)) }
    }
    Surface(modifier, shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
        Box(contentAlignment = Alignment.Center) {
            bitmap?.let { Image(it, contentDescription = artifact.title ?: artifact.name, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
                ?: Text(stringResource(R.string.artifact_label), style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
fun ArtifactsScreen(lane: LaneDetail, state: HostState, model: AppModel, confirm: Confirm) {
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { TextButton({ model.showArtifacts(false) }) { Text(stringResource(R.string.back)) }; Text(stringResource(R.string.artifacts)) }
        items(lane.artifacts, key = { it.name }) { ArtifactCard(lane.slug, it, state, model, confirm, false) }
    }
}

@Composable
fun JobLogScreen(log: JobDetail, back: () -> Unit) {
    LazyColumn(contentPadding = PaddingValues(16.dp)) {
        item { TextButton(back) { Text(stringResource(R.string.back)) }; Text(log.job.name, style = MaterialTheme.typography.titleLarge) }
        item { SelectionContainer { Text(log.argv.joinToString(" "), style = FieldCode) } }
        items(log.log) { line -> SelectionContainer { Text(line, style = FieldCode) } }
    }
}

@Composable
fun NewSessionScreen(hosts: List<HostState>, state: HostState, model: AppModel, confirm: Confirm) {
    val busy by model.busy.collectAsStateWithLifecycle()
    var lane by rememberSaveable(state.host.id) { mutableStateOf("") }
    var engine by rememberSaveable(state.host.id) { mutableStateOf("") }
    var title by rememberSaveable { mutableStateOf("") }
    var message by rememberSaveable { mutableStateOf("") }
    val lanes = state.desk?.lanes.orEmpty().filter { canControl(state.desk?.viewer?.lanes ?: state.host.lanes, it.slug) }
    val engines = state.desk?.engines.orEmpty()
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { TextButton(model::closeSession) { Text(stringResource(R.string.back)) }; Text(stringResource(R.string.new_session), style = MaterialTheme.typography.headlineMedium) }
        item { Choice(stringResource(R.string.hosts), state.host.id, hosts.map { it.host.id to it.host.name }) { model.selectHost(it); model.beginSession() } }
        item { Choice(stringResource(R.string.lane_label), lane, lanes.map { it.slug to it.title }) { lane = it } }
        item { Choice(stringResource(R.string.engine_label), engine, engines.map { it to it }) { engine = it } }
        item { OutlinedTextField(title, { if (it.length <= 120) title = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.title_label)) }) }
        item { OutlinedTextField(message, { if (it.length <= 8000) message = it }, Modifier.fillMaxWidth(), minLines = 3, label = { Text(stringResource(R.string.first_message)) }) }
        item { Button({ confirm(model.text(R.string.new_session), model.text(R.string.action_summary, lane, message),
            Actions.session(lane, engine, title, message), model.text(R.string.session_created)) },
            enabled = !busy && state.link == Link.Live && lanes.any { it.slug == lane } && engine in engines && title.trim().isNotEmpty() && message.trim().isNotEmpty()) {
            Text(stringResource(R.string.create_session))
        } }
    }
}

@Composable
private fun Choice(label: String, value: String, options: List<Pair<String, String>>, select: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton({ expanded = true }) { Text(stringResource(R.string.choice, label, options.firstOrNull { it.first == value }?.second.orEmpty())) }
        DropdownMenu(expanded, { expanded = false }) {
            options.forEach { (id, title) -> DropdownMenuItem(text = { Text(title) }, onClick = { select(id); expanded = false }) }
        }
    }
}

@Composable
fun PairRequestScreen(request: PairingProgress, model: AppModel) {
    var remaining by remember(request.expires) { mutableStateOf("") }
    LaunchedEffect(request.expires, request.state) {
        val timer = PairCountdown(request.expires, java.time.Clock.fixed(model.now(), java.time.ZoneOffset.UTC))
        remaining = timer.text()
        while (request.state == PairState.WAITING) {
            remaining = PairCountdown(request.expires, java.time.Clock.fixed(model.now(), java.time.ZoneOffset.UTC)).text()
            if (remaining == "00:00") break
            delay(250)
        }
    }
    LazyColumn(contentPadding = PaddingValues(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Text(stringResource(R.string.connect_session), style = MaterialTheme.typography.headlineMedium); Text(stringResource(R.string.pairing_label)) }
        item { Text(stringResource(R.string.confirm_host), style = MaterialTheme.typography.titleLarge); Text(stringResource(R.string.request_sent_host, request.host)) }
        item { Text(stringResource(R.string.phone_host), style = MaterialTheme.typography.headlineLarge); Text(stringResource(pairStateString(request.state))) }
        item { Card { Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text(stringResource(R.string.identified_session)); Text(request.host)
            Text(stringResource(R.string.scope, request.lanes?.joinToString(", ") ?: stringResource(R.string.all)))
        } } }
        item {
            Text(stringResource(R.string.compare_host))
            Surface(color = MaterialTheme.colorScheme.surfaceVariant) { Text(request.code, Modifier.fillMaxWidth().padding(24.dp), style = FieldCode.copy(fontSize = MaterialTheme.typography.headlineLarge.fontSize)) }
            Text(stringResource(R.string.code_read)); Text(stringResource(R.string.session_identified))
            Text(stringResource(if (request.state == PairState.CONFIRMED) R.string.host_confirmed else R.string.host_confirmation_pending))
        }
        item {
            request.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (request.state == PairState.WAITING && request.error == null) {
                Text(stringResource(R.string.expires_in, remaining))
                OutlinedButton(model::cancelRequest) { Text(stringResource(R.string.cancel_request)) }
            } else TextButton(model::dismissPairRequest) { Text(stringResource(R.string.back)) }
            Text(stringResource(R.string.no_access), style = MaterialTheme.typography.bodySmall)
        }
    }
}

private fun pairStateString(state: PairState): Int = when (state) {
    PairState.WAITING -> R.string.awaiting_confirmation
    PairState.CONFIRMED -> R.string.host_confirmed
    PairState.REFUSED -> R.string.pair_refused
    PairState.EXPIRED -> R.string.pair_expired
    PairState.CANCELLED -> R.string.pair_cancelled
}
