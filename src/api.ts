export type Result<T> = { data: T | null; error: string | null };

// Alle Aufrufe liefern { data, error } statt zu werfen: Die Oberflaeche zeigt Fehler an Ort und
// Stelle an, ohne dass jeder Aufrufer try/catch braucht.
export async function request<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => null);
    if (!response.ok) return { data: null, error: body?.message ?? `HTTP ${response.status}` };
    return { data: body as T, error: null };
  } catch (error) {
    return { data: null, error: (error as Error).message };
  }
}

function send<T>(method: string, url: string, body?: unknown) {
  return request<T>(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const api = {
  post: <T>(url: string, body?: unknown) => send<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => send<T>('PATCH', url, body),
  delete: <T>(url: string) => send<T>('DELETE', url),
};

// Viktor ist der einzige, der das Board im Browser bedient; Agenten schreiben ueber den MCP.
export const UI_AUTHOR = 'Viktor';
