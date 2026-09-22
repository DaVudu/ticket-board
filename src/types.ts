export type Ticket = {
  key: string;
  summary: string;
  status: string;
  statusCategory: 'new' | 'indeterminate' | 'done' | string;
  type: string;
  priority: string;
  labels: string[];
  assignee: string | null;
  updated: string;
  dueDate: string | null;
  url: string;
};

export type TicketResponse = {
  fetchedAt: string;
  tickets: Ticket[];
};

export type UsageWindow = {
  label: string;
  percentUsed: number;
  resetsAt: string | null;
};

export type UsageSnapshot = {
  validAt: string;
  stale: boolean;
  warning?: string;
  windows: UsageWindow[];
  breakdown?: { name: string; percent: number }[] | null;
};

export type RunStep = {
  at: string;
  kind: 'tool' | 'text';
  label: string;
};

export type Run = {
  key: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  steps?: RunStep[];
  result: string | null;
  error: string | null;
};

export type RunState = {
  current: Run | null;
  history: Run[];
};

export type ApiError = {
  error: string;
  message: string;
};
