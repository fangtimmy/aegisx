import type { AgentSummary, ConversationMessage } from "./agent";
import type { RunPublic } from "./run";

export type RunStreamEvent =
	| {
			type: "ready";
			runId: string;
			cursor: number;
	  }
	| {
			type: "run.updated";
			run: RunPublic;
			cursor?: number;
	  }
	| {
			type: "agent.updated";
			agent: AgentSummary;
			cursor?: number;
	  }
	| {
			type: "agent.activity";
			agentId: string;
			activity: "retrying" | "compacting" | null;
			detail?: string;
	  }
	| {
			type: "message.progress";
			agentId: string;
			messageId: string;
			revision: number;
			message: Record<string, unknown>;
	  }
	| {
			type: "tool.progress";
			agentId: string;
			toolCallId: string;
			revision: number;
			toolName: string;
			args: unknown;
			result?: unknown;
			status: "running" | "done" | "error";
			isError?: boolean;
			terminal?: "timed_out" | "cancelled" | "failed";
			terminalMessage?: string;
	  }
	| {
			type: "message.committed";
			agentId: string;
			cursor: number;
			message: ConversationMessage;
	  };
