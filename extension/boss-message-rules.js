export function classifyBossMessage(value) {
  const message = String(value || "")
    .replace(/\s+/g, "")
    .toLowerCase();
  if (
    /不(?:太|完全|是很|怎么)?(?:合适|适合|匹配|符合|吻合|一致)|暂不考虑|暂时不考虑|与.{0,12}(?:要求|岗位|职位).{0,6}(?:有差距|有出入)|(?:经验|经历|技能).{0,12}(?:不符|差距)|感谢.{0,12}(?:投递|申请).{0,20}(?:但|但是).{0,20}需要.{0,6}(?:其他|其它)(?:经验|技能)|遗憾.{0,20}(?:未能|无法|不能)|sorry.{0,30}(?:not|unfortunately)|not(?:a)?(?:good)?(?:fit|suitable)/i.test(
      message,
    )
  )
    return "rejection";
  // Receipt notices, negative requests and generic mentions of CVs are not asks.
  if (
    /(?:不用|不需要|无需|不必|不要).{0,8}(?:简历|cv|resume)|(?:收到|看过|查看了|已查看|已发送|已发给).{0,10}(?:简历|cv|resume)|(?:简历|cv|resume).{0,8}(?:已收到|收到了|已发送)/i.test(
      message,
    )
  )
    return "unknown";
  if (
    /(?:发|给|提供|投递|发送|附上|交换).{0,12}(?:简历|\bcv\b|resume)|(?:简历|\bcv\b|resume).{0,12}(?:发|给|提供|投递|发送|看一下|看看)|(?:看|看看|查看|要|求).{0,8}(?:你|您|一份|一下|附件).{0,6}(?:简历|\bcv\b|resume)|(?:可以|能|方便|麻烦|请|想).{0,8}(?:看|了解).{0,10}(?:简历|cv|resume)|(?:send|share|provide).{0,20}(?:cv|resume)/i.test(
      message,
    )
  )
    return "resume_request";
  return "unknown";
}

export function chooseChineseResume(names) {
  const matches = names.filter((name) =>
    /(?:^|[-_.\s(（])(?:cn|zh(?:[-_]cn)?|chinese)(?=$|[-_.\s)）])|中文|简体/i.test(
      name,
    ),
  );
  return matches.length === 1 ? matches[0] : null;
}
