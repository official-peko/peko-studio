// Minimal JSON-RPC 2.0 over a WebSocket.
//
// The native host relays the language server so that one WebSocket text frame
// carries exactly one JSON-RPC message. Content-Length framing lives on the
// native side, so this transport only sends and parses whole JSON messages.

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
type NotificationHandler = (params: unknown) => void
type RequestHandler = (params: unknown) => unknown

export class JsonRpcConnection {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, Pending>()
  private notifications = new Map<string, NotificationHandler>()
  private requests = new Map<string, RequestHandler>()
  private outbox: string[] = []
  private open = false

  onOpen?: () => void
  onClose?: () => void

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.onopen = () => {
      this.open = true
      for (const message of this.outbox) this.ws.send(message)
      this.outbox = []
      this.onOpen?.()
    }
    this.ws.onmessage = (event) => this.receive(String(event.data))
    this.ws.onclose = () => {
      this.open = false
      this.onClose?.()
    }
  }

  /// Send a request and resolve with its result (or reject with its error).
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return promise
  }

  /// Send a notification, which has no reply.
  notify(method: string, params?: unknown): void {
    this.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  /// Handle a server-to-client notification.
  onNotification(method: string, handler: NotificationHandler): void {
    this.notifications.set(method, handler)
  }

  /// Handle a server-to-client request, replying with the handler's return.
  onRequest(method: string, handler: RequestHandler): void {
    this.requests.set(method, handler)
  }

  /// Close the underlying socket.
  close(): void {
    this.ws.close()
  }

  private send(message: string): void {
    if (this.open) this.ws.send(message)
    else this.outbox.push(message)
  }

  private receive(data: string): void {
    let message: {
      id?: number
      method?: string
      params?: unknown
      result?: unknown
      error?: unknown
    }
    try {
      message = JSON.parse(data)
    } catch {
      return
    }

    // A response carries an id and no method.
    if (message.method === undefined && message.id !== undefined) {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error !== undefined) waiter.reject(message.error)
      else waiter.resolve(message.result)
      return
    }

    if (message.method === undefined) return

    // A request carries both a method and an id and expects a reply.
    if (message.id !== undefined) {
      const handler = this.requests.get(message.method)
      const result = handler ? handler(message.params) : null
      this.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      return
    }

    // Otherwise it is a notification.
    this.notifications.get(message.method)?.(message.params)
  }
}
