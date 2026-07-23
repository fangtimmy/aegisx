import type { AgentSummary, ConversationMessage } from "./agent";
import type { PublicAgentMessage } from "./message";
import type { RunPublic } from "./run";

export type TransientActivity = "retrying" | "compacting";

export type ToolProgressStatus = "running" | "done" | "error";

export type ToolTerminal = "timed_out" | "cancelled" | "failed";

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
			activity: TransientActivity | null;
			detail?: string;
	  }
	| {
			type: "message.progress";
			agentId: string;
			messageId: string;
			revision: number;
			message: PublicAgentMessage;
	  }
	| {
			type: "tool.progress";
			agentId: string;
			toolCallId: string;
			revision: number;
			toolName: string;
			args: unknown;
			result?: unknown;
			status: ToolProgressStatus;
			isError?: boolean;
			terminal?: ToolTerminal;
			terminalMessage?: string;
	  }
	| {
			type: "message.committed";
			agentId: string;
			cursor: number;
			message: ConversationMessage;
	  };
