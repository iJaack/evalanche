/** Feedback submission for on-chain reputation reporting */
export interface FeedbackSubmission {
  targetAgentId: string;
  taskRef: string;
  score: number;
  metadata?: Record<string, unknown>;
}
