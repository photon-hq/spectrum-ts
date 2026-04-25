const PART_PREFIX = /^p:(\d+)\//;

export const formatChildId = (partIndex: number, parentGuid: string): string =>
  `p:${partIndex}/${parentGuid}`;

export const parseTapbackTarget = (
  target: string
): { guid: string; partIndex: number } => {
  const match = target.match(PART_PREFIX);
  const guid = target.replace(PART_PREFIX, "");
  const partIndex = match ? Number(match[1]) : 0;
  return { guid, partIndex };
};

export const parseChildId = (
  id: string
): { parentGuid: string; partIndex: number } | null => {
  const match = id.match(PART_PREFIX);
  if (!match) {
    return null;
  }
  return {
    parentGuid: id.replace(PART_PREFIX, ""),
    partIndex: Number(match[1]),
  };
};
