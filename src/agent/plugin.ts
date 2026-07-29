// The Peko skills for the assistant. The canonical source is the plugin under
// agent-plugin/ at the repo root; every file is imported here as raw text at
// build time (single source of truth, no drift) and handed to the native side,
// which writes them into an IDE-owned directory. The agent CLI is then spawned
// with that directory as a session plugin dir, so the skills are available
// without touching the user's project or global config.
//
// Paths are relative to the plugin root. A skill's SKILL.md is loaded whenever
// the assistant matches its description; the reference files under it are read
// on demand, so depth costs nothing until it is needed.
import developmentSkill from '../../agent-plugin/skills/peko-development/SKILL.md?raw'
import referenceCli from '../../agent-plugin/skills/peko-development/references/cli.md?raw'
import referenceLanguage from '../../agent-plugin/skills/peko-development/references/pekoscript.md?raw'
import referencePekoui from '../../agent-plugin/skills/peko-development/references/pekoui.md?raw'
import referencePlatform from '../../agent-plugin/skills/peko-development/references/platform.md?raw'
import referenceAppStores from '../../agent-plugin/skills/peko-development/references/app-stores.md?raw'
import referenceEnvironment from '../../agent-plugin/skills/peko-development/references/environment.md?raw'
import styleSkill from '../../agent-plugin/skills/peko-product-style/SKILL.md?raw'
import pluginManifest from '../../agent-plugin/.claude-plugin/plugin.json?raw'
import { peko } from '@peko/client'

/// One file to write, as a path relative to the plugin root.
interface PluginFile {
  path: string
  content: string
}

const files: PluginFile[] = [
  { path: '.claude-plugin/plugin.json', content: pluginManifest },
  { path: 'skills/peko-development/SKILL.md', content: developmentSkill },
  { path: 'skills/peko-development/references/cli.md', content: referenceCli },
  { path: 'skills/peko-development/references/pekoscript.md', content: referenceLanguage },
  { path: 'skills/peko-development/references/pekoui.md', content: referencePekoui },
  { path: 'skills/peko-development/references/platform.md', content: referencePlatform },
  { path: 'skills/peko-development/references/app-stores.md', content: referenceAppStores },
  { path: 'skills/peko-development/references/environment.md', content: referenceEnvironment },
  { path: 'skills/peko-product-style/SKILL.md', content: styleSkill },
]

/// Install (or refresh) the assistant's Peko plugin on the host. Safe to call
/// more than once; the native side rewrites the files each time.
export async function installAgentPlugin(): Promise<void> {
  try {
    await peko.invoke('ide.agent.install_plugin', { files })
  } catch {
    // No bridge, or the host declined; the agent still runs without the skills.
  }
}
