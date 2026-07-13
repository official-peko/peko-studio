// The Peko development skill for the assistant. The canonical source is the
// plugin under agent-plugin/ at the repo root; it is imported here as raw text
// at build time (single source of truth, no drift) and handed to the native
// side, which installs it into an IDE-owned directory. The agent CLI is then
// spawned with that directory as a session plugin dir, so the skill is available
// without touching the user's project or global config.
import skillMarkdown from '../../agent-plugin/skills/peko-development/SKILL.md?raw'
import pluginManifest from '../../agent-plugin/.claude-plugin/plugin.json?raw'
import { peko } from '@peko/client'

/// Install (or refresh) the assistant's Peko development plugin on the host.
/// Safe to call more than once; the native side just rewrites the files.
export async function installAgentPlugin(): Promise<void> {
  try {
    await peko.invoke('ide.agent.install_plugin', { skill: skillMarkdown, manifest: pluginManifest })
  } catch {
    // No bridge, or the host declined; the agent still runs without the skill.
  }
}
