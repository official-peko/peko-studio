import { useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { peko } from '@peko/client'
import { registerPekoLanguage, PEKO_LANGUAGE_ID } from './monacoSetup'
import { languageForPath, registerLanguageExtras } from './languages'
import {
  startPekoLanguageClient,
  setFileResolver,
  setDefinitionOpener,
  setDiagnosticsListener,
  type PekoLanguageClient,
  type FileDiagnostic,
} from '../lsp/pekoLsp'
import {
  readFile,
  imageMime,
  isMarkdown,
  revealInFinder,
  projectSources,
  type Tab,
} from '../ide/workspace'
import { Breadcrumbs } from './Breadcrumbs'
import { ImageViewer } from './ImageViewer'
import { MarkdownPreview } from './MarkdownPreview'

// Reveal a definition target (a range or a position) in the editor.
function revealTarget(
  editor: monaco.editor.IStandaloneCodeEditor,
  target: monaco.IRange | monaco.IPosition | undefined,
): void {
  if (!target) return
  if ('startLineNumber' in target) {
    editor.revealRangeInCenter(target)
    editor.setSelection(target)
  } else {
    editor.revealPositionInCenter(target)
    editor.setPosition(target)
  }
  editor.focus()
}

// The workspace bootstrap the editor needs: the project root and relay port for
// the language client.
export interface Boot {
  root?: string
  lspPort?: number
}

/// The editor pane. Hosts one Monaco editor and swaps its model as the active
/// tab changes, keeping a model and scroll/cursor state per open file. A single
/// language client serves every open document.
export function EditorArea({
  boot,
  tabs,
  activePath,
  reveal,
  reload,
  onStatus,
  onDirty,
  onRequestOpen,
  onDiagnostics,
}: {
  boot: Boot | null
  tabs: Tab[]
  activePath: string | null
  // A location to scroll to and select once its file is the active model. Used
  // by project search to jump to a hit.
  reveal?: { path: string; line: number; column: number } | null
  // A request to refresh a file's model from disk after an external write (the
  // settings editor, the package manager). The token changes per request.
  reload?: { path: string; token: number } | null
  onStatus?: (ready: boolean) => void
  onDirty?: (path: string, dirty: boolean) => void
  // Open a file in a tab (used by go-to-definition across files).
  onRequestOpen?: (path: string) => void
  // The current project-wide diagnostics, for the Problems panel.
  onDiagnostics?: (diagnostics: FileDiagnostic[]) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const clientRef = useRef<PekoLanguageClient | null>(null)
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>())
  const viewStateRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>())
  // The last saved text per open path; the file is dirty when its model differs.
  const savedRef = useRef(new Map<string, string>())
  const currentPathRef = useRef<string | null>(null)
  const onDirtyRef = useRef(onDirty)
  onDirtyRef.current = onDirty
  const onRequestOpenRef = useRef(onRequestOpen)
  onRequestOpenRef.current = onRequestOpen
  const onDiagnosticsRef = useRef(onDiagnostics)
  onDiagnosticsRef.current = onDiagnostics
  // The latest peko-language-server diagnostics, merged with Monaco's built-in
  // markers (TS/JS/JSON/CSS) for the Problems panel.
  const pekoDiagsRef = useRef<FileDiagnostic[]>([])
  // A definition target to reveal once its file becomes the active model.
  const pendingRevealRef = useRef<{
    path: string
    target: monaco.IRange | monaco.IPosition | undefined
  } | null>(null)
  // Reveal a search hit: jump now if its file is active, else defer to the
  // model-swap effect once the file opens.
  useEffect(() => {
    if (!reveal) return
    const target: monaco.IPosition = { lineNumber: reveal.line, column: reveal.column || 1 }
    const editor = editorRef.current
    if (editor && currentPathRef.current === reveal.path) {
      revealTarget(editor, target)
    } else {
      pendingRevealRef.current = { path: reveal.path, target }
    }
  }, [reveal])

  const [editorInstance, setEditorInstance] =
    useState<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [activeName, setActiveName] = useState('')
  const [markdownPreview, setMarkdownPreview] = useState(false)
  const [markdownText, setMarkdownText] = useState('')

  const activeIsImage = activePath ? imageMime(activePath) !== null : false
  const activeIsMarkdown = activePath ? isMarkdown(activePath) : false
  const activeIsSvg = activePath ? /\.svg$/i.test(activePath) : false

  // Create the editor once. Layout is driven manually from a ResizeObserver
  // aligned to an animation frame; automaticLayout relays out mid-paint and
  // flickers the minimap during window and sidebar resizes.
  useEffect(() => {
    registerPekoLanguage()
    registerLanguageExtras()
    const host = hostRef.current
    if (!host) return

    const editor = monaco.editor.create(host, {
      theme: 'peko-dark',
      automaticLayout: false,
      fontSize: 13,
      lineHeight: 20,
      // SF Mono is the Xcode editor face; fall back through the system
      // monospace stack.
      fontFamily: '"SF Mono", SFMono-Regular, ui-monospace, Menlo, "Cascadia Code", monospace',
      fontLigatures: true,
      minimap: { enabled: true, renderCharacters: true, scale: 1 },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      scrollBeyondLastLine: false,
      padding: { top: 12 },
      renderWhitespace: 'selection',
      renderLineHighlight: 'all',
      tabSize: 4,
      'semanticHighlighting.enabled': true,
      contextmenu: true,
      multiCursorModifier: 'ctrlCmd',
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      tabCompletion: 'on',
      suggestSelection: 'first',
      snippetSuggestions: 'top',
      stickyScroll: { enabled: true },
      linkedEditing: true,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true },
      scrollbar: { useShadows: false, verticalScrollbarSize: 10 },
    })
    editorRef.current = editor
    setEditorInstance(editor)

    // Let the language client load definition-target files and route
    // cross-file navigation back here.
    setFileResolver(readFile)
    setDefinitionOpener((path, target) => {
      pendingRevealRef.current = { path, target }
      onRequestOpenRef.current?.(path)
    })

    // Route diagnostics to the Problems panel: the peko language server's
    // project-wide diagnostics merged with Monaco's built-in markers for the
    // other languages (TS/JS/JSX, JSON, CSS).
    const emitCombined = () => {
      const fromMarkers: FileDiagnostic[] = []
      for (const marker of monaco.editor.getModelMarkers({})) {
        if (marker.owner === 'peko-lsp') continue
        if (marker.severity < monaco.MarkerSeverity.Info) continue
        fromMarkers.push({
          file: marker.resource.path,
          line: marker.startLineNumber,
          column: marker.startColumn,
          severity:
            marker.severity >= monaco.MarkerSeverity.Error
              ? 'error'
              : marker.severity >= monaco.MarkerSeverity.Warning
                ? 'warning'
                : 'info',
          message: marker.message,
        })
      }
      onDiagnosticsRef.current?.([...pekoDiagsRef.current, ...fromMarkers])
    }
    setDiagnosticsListener((all) => {
      pekoDiagsRef.current = all
      emitCombined()
    })
    const markerSub = monaco.editor.onDidChangeMarkers(() => emitCombined())

    // Mark the active file dirty when its content differs from the last save.
    editor.onDidChangeModelContent(() => {
      const path = currentPathRef.current
      if (!path) return
      const model = editor.getModel()
      if (!model) return
      const saved = savedRef.current.get(path) ?? ''
      onDirtyRef.current?.(path, model.getValue() !== saved)
    })

    let frame = 0
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      cancelAnimationFrame(frame)
      // Pass explicit dimensions so Monaco does not re-measure a transiently
      // zero-sized container, and defer to an animation frame so the layout and
      // the browser paint happen together.
      frame = requestAnimationFrame(() =>
        editorRef.current?.layout({ width: rect.width, height: rect.height }),
      )
    })
    observer.observe(host)

    const saveDocument = async () => {
      await editor.getAction('editor.action.formatDocument')?.run()
      const model = editor.getModel()
      if (!model) return
      // Save under the active file's real path (the one used to open it). This
      // stays consistent with the dirty-tracking and model keys. model.uri.path
      // is a URI path, which on Windows is `/C:/...` with a leading slash before
      // the drive letter and fails the native write.
      const path = currentPathRef.current
      if (!path) return
      const text = model.getValue()
      try {
        await peko.invoke('ide.save', { path, text })
        // Persisted: this text is now the clean baseline.
        savedRef.current.set(path, text)
        onDirtyRef.current?.(path, false)
      } catch {
        // No bridge (dev browser); nothing to persist to.
      }
    }

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveDocument())

    // Editor font zoom on Cmd/Ctrl +, -, and 0 (reset), like VS Code. Line height
    // scales with the font (the editor uses a fixed line height, so changing only
    // the font size grows glyphs but not the line spacing).
    const DEFAULT_FONT_SIZE = 13
    const LINE_HEIGHT_RATIO = 20 / 13
    const applyFontSize = (size: number) => {
      const clamped = Math.max(8, Math.min(40, Math.round(size)))
      editor.updateOptions({
        fontSize: clamped,
        lineHeight: Math.round(clamped * LINE_HEIGHT_RATIO),
      })
    }
    const zoomFont = (delta: number) =>
      applyFontSize(editor.getOption(monaco.editor.EditorOption.fontSize) + delta)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Equal, () => zoomFont(1))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.NumpadAdd, () => zoomFont(1))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Minus, () => zoomFont(-1))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.NumpadSubtract, () => zoomFont(-1))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit0, () =>
      applyFontSize(DEFAULT_FONT_SIZE),
    )

    // Native menu items emit a `menu` event with their action id; map the
    // custom ones onto editor actions (role items act natively).
    const menuUnsub = peko.on('menu', (data) => {
      const id = (data as { id?: string })?.id
      if (!id) return
      switch (id) {
        case 'file.save':
          void saveDocument()
          break
        case 'file.reveal': {
          // The active file's real path, not the URI path (`/C:/...` on Windows).
          const path = currentPathRef.current
          if (path) void revealInFinder(path)
          break
        }
        case 'edit.find':
          editor.getAction('actions.find')?.run()
          break
        case 'edit.replace':
          editor.getAction('editor.action.startFindReplaceAction')?.run()
          break
        case 'edit.format':
          editor.getAction('editor.action.formatDocument')?.run()
          break
        case 'view.commands':
          editor.getAction('editor.action.quickCommand')?.run()
          break
        case 'view.wordwrap': {
          const wrap = editor.getOption(monaco.editor.EditorOption.wordWrap)
          editor.updateOptions({ wordWrap: wrap === 'on' ? 'off' : 'on' })
          break
        }
        case 'go.definition':
          editor.getAction('editor.action.revealDefinition')?.run()
          break
        case 'go.line':
          editor.getAction('editor.action.gotoLine')?.run()
          break
        default:
          break
      }
    })

    return () => {
      menuUnsub?.()
      markerSub.dispose()
      observer.disconnect()
      cancelAnimationFrame(frame)
      setEditorInstance(null)
      editorRef.current = null
      editor.dispose()
    }
  }, [])

  // Start the language client once the bootstrap arrives. It lives for the
  // component's lifetime and serves every open document.
  useEffect(() => {
    if (!boot || clientRef.current) return
    const root = boot.root ? monaco.Uri.file(boot.root).toString() : undefined
    const client = startPekoLanguageClient(root, boot.lspPort)
    clientRef.current = client
    client.connection.onClose = () => onStatus?.(false)
    onStatus?.(true)
    // Register any PekoScript models opened before the client existed.
    for (const model of modelsRef.current.values()) {
      if (model.getLanguageId() === PEKO_LANGUAGE_ID) client.openModel(model)
    }

    // Open every project source to the server so the Problems panel shows the
    // whole project's diagnostics, not just the open tabs.
    void projectSources().then((files) => {
      for (const file of files) {
        void readFile(file).then((text) => {
          if (text !== null) client.openBackground(monaco.Uri.file(file).toString(), text)
        })
      }
    })
    return () => {
      client.dispose()
      clientRef.current = null
    }
  }, [boot, onStatus])

  // Switch to the active tab's model, creating and registering it on first open,
  // then dispose models whose tabs have closed. Sequenced so the editor never
  // shows a disposed model.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    let cancelled = false

    void (async () => {
      if (activePath && imageMime(activePath) !== null) {
        // Binary image: no text model. Save the outgoing view state, detach the
        // model, and let the image viewer render over the editor.
        const current = editor.getModel()
        if (current) viewStateRef.current.set(current.uri.toString(), editor.saveViewState())
        editor.setModel(null)
        currentPathRef.current = null
        setActiveName(activePath.split('/').pop() ?? activePath)
      } else if (activePath) {
        const current = editor.getModel()
        if (current) viewStateRef.current.set(current.uri.toString(), editor.saveViewState())

        let model = modelsRef.current.get(activePath)
        if (!model) {
          const text = (await readFile(activePath)) ?? `// Unable to read ${activePath}\n`
          if (cancelled) return
          const uri = monaco.Uri.file(activePath)
          const language = languageForPath(activePath)
          model =
            monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, language, uri)
          modelsRef.current.set(activePath, model)
          savedRef.current.set(activePath, text)
          // Only PekoScript files go to the language server; other languages use
          // Monaco's built-in services.
          if (language === PEKO_LANGUAGE_ID) clientRef.current?.openModel(model)
        }

        currentPathRef.current = activePath
        if (editor.getModel() !== model) {
          editor.setModel(model)
          const state = viewStateRef.current.get(model.uri.toString())
          if (state) editor.restoreViewState(state)
        }
        editor.focus()
        setActiveName(activePath.split('/').pop() ?? activePath)

        // A go-to-definition that opened this file reveals its target now.
        const pending = pendingRevealRef.current
        if (pending && pending.path === activePath) {
          pendingRevealRef.current = null
          revealTarget(editor, pending.target)
        }
      } else {
        currentPathRef.current = null
        editor.setModel(null)
        setActiveName('')
      }

      if (cancelled) return
      // Dispose any model whose tab is gone, but never the one on screen.
      const open = new Set(tabs.map((tab) => tab.path))
      for (const path of [...modelsRef.current.keys()]) {
        if (open.has(path)) continue
        const model = modelsRef.current.get(path)
        if (!model || editor.getModel() === model) continue
        clientRef.current?.closeModel(model)
        modelsRef.current.delete(path)
        viewStateRef.current.delete(model.uri.toString())
        savedRef.current.delete(path)
        onDirtyRef.current?.(path, false)
        model.dispose()
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activePath, tabs])

  // Refresh a single open file's model from disk, unless the tab has unsaved
  // edits (dirty) - those are never clobbered. Used both by the reload prop and
  // by the focus-revert below.
  const refreshModel = useRef((path: string) => {
    const model = modelsRef.current.get(path)
    if (!model || model.isDisposed()) return
    const saved = savedRef.current.get(path) ?? ''
    if (model.getValue() !== saved) return
    void readFile(path).then((text) => {
      if (text === null || model.isDisposed()) return
      // Re-check dirty and staleness at resolve time.
      if (model.getValue() !== (savedRef.current.get(path) ?? '')) return
      if (model.getValue() === text) return
      model.setValue(text)
      savedRef.current.set(path, text)
      onDirtyRef.current?.(path, false)
    })
  })

  // Refresh a file's model from disk after a known external write (the settings
  // editor, the package manager).
  useEffect(() => {
    if (reload) refreshModel.current(reload.path)
  }, [reload])

  // Revert every open, non-dirty file when the window regains focus or becomes
  // visible, so edits made by other tools (git, the CLI, another editor) show up
  // without reopening the tab.
  useEffect(() => {
    const revertAll = () => {
      for (const path of modelsRef.current.keys()) refreshModel.current(path)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') revertAll()
    }
    window.addEventListener('focus', revertAll)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', revertAll)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // The native file watcher pushes ide.fs.change {path} when an open file
  // changes on disk; reload that file live, even while the window is focused.
  useEffect(() => {
    const off = peko.on('ide.fs.change', (data) => {
      const path = (data as { path?: string })?.path
      if (path) refreshModel.current(path)
    })
    return off
  }, [])

  // Each file opens in edit mode.
  useEffect(() => {
    setMarkdownPreview(false)
  }, [activePath])

  // Keep the preview in sync with the live editor content while it is showing.
  useEffect(() => {
    if (!markdownPreview || !editorInstance) return
    const update = () => setMarkdownText(editorInstance.getModel()?.getValue() ?? '')
    update()
    const sub = editorInstance.onDidChangeModelContent(update)
    return () => sub.dispose()
  }, [markdownPreview, activePath, editorInstance])

  return (
    <div className="editor-pane">
      {editorInstance && activePath && !activeIsImage && (
        <div className="editor-topline">
          <Breadcrumbs editor={editorInstance} file={activeName} />
          {(activeIsMarkdown || activeIsSvg) && (
            <button
              className="preview-toggle"
              onClick={() => setMarkdownPreview((previous) => !previous)}
            >
              {markdownPreview ? 'Edit' : 'Preview'}
            </button>
          )}
        </div>
      )}
      <div className="editor-body">
        <div ref={hostRef} className="editor-host" />
        {activeIsImage && activePath && (
          <div className="editor-overlay">
            <ImageViewer path={activePath} />
          </div>
        )}
        {activeIsMarkdown && markdownPreview && (
          <div className="editor-overlay">
            <MarkdownPreview text={markdownText} />
          </div>
        )}
        {activeIsSvg && markdownPreview && (
          <div className="editor-overlay page-image">
            <img
              className="svg-preview"
              src={`data:image/svg+xml;utf8,${encodeURIComponent(markdownText)}`}
              alt="SVG preview"
            />
          </div>
        )}
      </div>
    </div>
  )
}
