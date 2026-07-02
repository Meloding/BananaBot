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
  multimodalEnabled: boolean;
  visionModel: string;
  audioModel: string;
  maxMediaBytes: number;
  videoFrameCount: number;
  replyMaxLength: number;
  replyMaxSegments: number;
  stripMarkdown: boolean;
  allowGlobalUsageReport: boolean;
}
