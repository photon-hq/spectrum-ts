export interface User {
  readonly __platform: string;
  readonly id: string;
  readonly kind?: "agent";
}

export interface AgentSender extends User {
  readonly kind: "agent";
}
