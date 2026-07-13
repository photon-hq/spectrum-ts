export const dmChatGuid = (address: string): string => `any;-;${address}`;

// Chat guids encode their kind in the separator: groups use `;+;`, while DMs
// use `;-;`.
export const chatTypeFromGuid = (guid: string): "dm" | "group" =>
  guid.includes(";+;") ? "group" : "dm";
