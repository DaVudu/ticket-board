export type StatusCategory = 'new' | 'indeterminate' | 'done';

export type BoardConfig = {
  projectKey: string;
  projectName: string;
  statuses: { name: string; category: StatusCategory }[];
  types: string[];
  priorities: string[];
  defaultType: string;
  defaultPriority: string;
  assignees: string[];
  linkTypes: { id: string; outward: string; inward: string }[];
};

export type Ticket = {
  key: string;
  title: string;
  status: string;
  statusCategory: StatusCategory;
  type: string;
  priority: string;
  assignee: string | null;
  labels: string[];
  backlog: boolean;
  rank: number;
  // Offene Blocker: Tickets, die dieses blockieren und noch nicht erledigt sind.
  blockedBy: string[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type Comment = {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type Link = {
  id: number;
  type: string;
  direction: 'outward' | 'inward';
  label: string;
  ticket: { key: string; title: string; status: string; statusCategory: StatusCategory };
};

export type TicketDetail = Ticket & {
  description: string;
  comments: Comment[];
  links: Link[];
};

export type TicketFields = {
  title: string;
  description: string;
  status: string;
  type: string;
  priority: string;
  assignee: string | null;
  labels: string[];
  backlog: boolean;
};

export type TicketList = {
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
