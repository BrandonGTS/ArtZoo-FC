export interface DiscussionTransport {
  listUrl: string;
  createUrl: string;
  uploadUrl: string;
  scopeBody?: Record<string, unknown>;
  removeMethod?: 'POST' | 'PATCH';
  removeUrl?(commentId: string): string;
  moderateUrl?(commentId: string): string;
}
