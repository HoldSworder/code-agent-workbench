#!/usr/bin/env node
// Query workflow structure, current position, and available navigation paths.
// Receives pre-processed workflow JSON via base64 --config to avoid YAML parsing.

const args = process.argv.slice(2)

function parseArgs(args) {
  const opts = {}
  const positional = []
  let i = 0
  while (i < args.length) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      opts[key] = args[i + 1]
      i += 2
    }
    else {
      positional.push(args[i])
      i++
    }
  }
  return { opts, cmd: positional[0] ?? 'help' }
}

const { opts, cmd } = parseArgs(args)

if (!opts.config) {
  console.error(JSON.stringify({ error: 'Missing required arg: --config <base64_json>' }))
  process.exit(1)
}

let stages
try {
  stages = JSON.parse(Buffer.from(opts.config, 'base64').toString('utf-8'))
}
catch (e) {
  console.error(JSON.stringify({ error: `Failed to decode --config: ${e.message}` }))
  process.exit(1)
}

if (!Array.isArray(stages) || stages.length === 0) {
  console.error(JSON.stringify({ error: '--config must decode to a non-empty array of stages' }))
  process.exit(1)
}

const currentStageId = opts.currentStage
const currentPhaseId = opts.currentPhase

function findPosition() {
  for (let si = 0; si < stages.length; si++) {
    const stage = stages[si]
    if (stage.id !== currentStageId) continue
    for (let pi = 0; pi < stage.phases.length; pi++) {
      if (stage.phases[pi].id === currentPhaseId) {
        return { stageIndex: si, phaseIndex: pi }
      }
    }
    return { stageIndex: si, phaseIndex: -1 }
  }
  return null
}

function handleCurrent() {
  const pos = findPosition()
  if (!pos) {
    console.log(JSON.stringify({ error: `Stage "${currentStageId}" not found in workflow` }))
    return
  }
  const stage = stages[pos.stageIndex]
  const phase = pos.phaseIndex >= 0 ? stage.phases[pos.phaseIndex] : null

  const result = {
    stage: {
      id: stage.id,
      name: stage.name,
      index: pos.stageIndex,
      totalStages: stages.length,
    },
    phase: phase
      ? {
          id: phase.id,
          name: phase.name,
          index: pos.phaseIndex,
          totalPhases: stage.phases.length,
        }
      : null,
    progress: phase
      ? `Stage ${pos.stageIndex + 1}/${stages.length}, Phase ${pos.phaseIndex + 1}/${stage.phases.length}`
      : `Stage ${pos.stageIndex + 1}/${stages.length}, Phase unknown`,
  }
  console.log(JSON.stringify(result, null, 2))
}

function handleMap() {
  const result = {
    stages: stages.map(stage => ({
      id: stage.id,
      name: stage.name,
      current: stage.id === currentStageId,
      phases: stage.phases.map(phase => {
        const entry = {
          id: phase.id,
          name: phase.name,
          optional: !!phase.optional,
          current: stage.id === currentStageId && phase.id === currentPhaseId,
        }
        if (phase.triggers && phase.triggers.length > 0) {
          entry.triggers = phase.triggers
        }
        return entry
      }),
    })),
  }
  console.log(JSON.stringify(result, null, 2))
}

function handleNext() {
  const pos = findPosition()
  if (!pos) {
    console.log(JSON.stringify({ error: `Stage "${currentStageId}" not found in workflow` }))
    return
  }

  const stage = stages[pos.stageIndex]
  const result = {}

  // Find default next phase within the same stage
  if (pos.phaseIndex >= 0 && pos.phaseIndex < stage.phases.length - 1) {
    const nextPhase = stage.phases[pos.phaseIndex + 1]
    result.defaultNext = {
      stageId: stage.id,
      phaseId: nextPhase.id,
      phaseName: nextPhase.name,
      optional: !!nextPhase.optional,
    }
  }

  // Find next stage's first phase
  if (pos.stageIndex < stages.length - 1) {
    const nextStage = stages[pos.stageIndex + 1]
    const firstPhase = nextStage.phases[0]
    result.nextStage = {
      stageId: nextStage.id,
      stageName: nextStage.name,
      phaseId: firstPhase?.id,
      phaseName: firstPhase?.name,
    }
    if (nextStage.gate) {
      result.nextStage.gateRequired = nextStage.gate
    }
  }

  // Collect optional phases in the current stage that are not current
  const optionalPhases = stage.phases.filter(
    p => p.optional && p.id !== currentPhaseId,
  )
  if (optionalPhases.length > 0) {
    result.optionalPhases = optionalPhases.map(p => ({
      stageId: stage.id,
      phaseId: p.id,
      phaseName: p.name,
      triggers: p.triggers ?? [],
    }))
  }

  console.log(JSON.stringify(result, null, 2))
}

switch (cmd) {
  case 'current':
    handleCurrent()
    break
  case 'map':
    handleMap()
    break
  case 'next':
    handleNext()
    break
  default:
    console.log(`Usage: node run.mjs --config <base64_json> --current-stage <id> --current-phase <id> <command>

Commands:
  current  Show current stage/phase position and info
  map      Show full workflow map with current position marked
  next     Show next possible phases and conditions

Options:
  --dir <path>              Worktree path (optional context)
  --config <base64>         Base64-encoded workflow stages JSON (required)
  --current-stage <id>      Current stage ID
  --current-phase <id>      Current phase ID`)
    break
}
