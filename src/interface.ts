export interface IConfig {
  openaiApiKey: string;
  openaiOrganizationID?: string;
  openaiBasePath?: string;
  openaiModel: string;
  chatgptTriggerKeyword: string;
  privateAutoReply: boolean;
  defaultGroupMode: "quiet" | "smart" | "active";
  botDataPath: string;
  historyMessageLimit: number;
  agentRouterEnabled: boolean;
}
