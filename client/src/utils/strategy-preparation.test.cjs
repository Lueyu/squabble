const {test}=require('node:test');
const assert=require('node:assert/strict');
const fixture=require('./simple-test-loader.cjs');

function normalize(cause,language='en') {
 return fixture().load('utils/strategy-preparation.ts').normalizeApiPreparationError(cause,language);
}
const apiError=error=>({response:{status:429,data:{error}}});

test('the actual HTTP 429 budget envelope explains the per-call input limit without leaking diagnostics',()=>{
 const cause=apiError({code:'LLM_BUDGET_EXCEEDED',reason:'input_tokens',
  message:'LLM budget limit reached: input_tokens. Review the budget before retrying.',
  taskId:'private-task',details:'{"authorization":"Bearer private-key"}',stack:'private-stack'});
 const result=normalize(cause);
 assert.equal(result.code,'LLM_BUDGET_EXCEEDED_INPUT_TOKENS');
 assert.match(result.message,/per-call input token limit/i);
 assert.match(result.message,/shorten/i);
 assert.doesNotMatch(JSON.stringify(result),/private|Bearer|authorization|budget limit reached/);
 const chinese=normalize(cause,'zh-CN');
 assert.equal(chinese.code,result.code);
 assert.match(chinese.message,/单次输入.*上限/);
 assert.match(chinese.message,/缩短/);
});

test('each budget reason and its durable failure code produce the same specific recovery message',()=>{
 const reasons={input_tokens:/per-call input/i,daily_tokens:/daily token/i,monthly_tokens:/monthly token/i,
  task_tokens:/task.*token/i,daily_calls:/daily.*call/i,task_calls:/task.*call/i};
 for(const [reason,message] of Object.entries(reasons)) {
  const result=normalize(apiError({code:'LLM_BUDGET_EXCEEDED',reason}));
  assert.equal(result.code,`LLM_BUDGET_EXCEEDED_${reason.toUpperCase()}`);
  assert.match(result.message,message);
  const durable=normalize(apiError({code:result.code,message:{en:'private-text','zh-CN':'private-text'}}));
  assert.equal(durable.code,result.code);
  assert.equal(durable.message,result.message);
  assert.match(normalize(apiError({code:result.code}),'zh-CN').message,/额度|上限/);
 }
});

test('unknown budget reasons keep a safe budget explanation and cannot become a code or visible text',()=>{
 const result=normalize(apiError({code:'LLM_BUDGET_EXCEEDED',reason:'private-key'}));
 assert.equal(result.code,'LLM_BUDGET_EXCEEDED');
 assert.match(result.message,/budget/i);
 assert.doesNotMatch(JSON.stringify(result),/private/);
});

test('local busy, unavailable and configuration failures use allowlisted envelope selectors',()=>{
 const cases={LOCAL_BUSY:/busy/i,LOCAL_UNAVAILABLE:/unavailable/i,LOCAL_AGENT_NOT_FOUND:/connected/i,
  LOCAL_COMPANION_OFFLINE:/offline/i,LOCAL_LOGIN_REQUIRED:/sign.in/i,
  LOCAL_INVALID_CONFIGURATION:/configuration/i,LOCAL_CONFIGURATION_UNSUPPORTED:/support/i};
 for(const [code,message] of Object.entries(cases)) {
  for(const error of [{code,message:'private-provider-secret'},{code:'BAD_REQUEST',message:code}]) {
   const result=normalize(apiError(error));
   assert.equal(result.code,code);
   assert.match(result.message,message);
   assert.doesNotMatch(result.message,/private|BAD_REQUEST/);
   assert.match(normalize(apiError(error),'zh-CN').message,/股友|连接|设置|登录|离线|配置/);
  }
 }
});

test('legacy Nest messages, malformed envelopes and arbitrary exceptions stay safely unknown',()=>{
 const causes=[undefined,null,'private-key',new Error('private-key'),
  {response:{data:{message:'private-provider-secret'}}},
  {response:{data:{message:'LOCAL_BUSY'}}},
  apiError({code:'private-key',message:'private-provider-secret',stack:'private-stack'}),
  apiError({code:'BAD_REQUEST',message:'LOCAL_BUSY private-provider-secret'}),
  apiError({code:['LOCAL_BUSY'],message:{en:'private-provider-secret'}}),
  apiError(['LOCAL_BUSY'])];
 for(const cause of causes) {
  const result=normalize(cause);
  assert.equal(result.code,'STRATEGY_PREPARATION_FAILED');
  assert.match(result.message,/preparation/i);
  assert.doesNotMatch(JSON.stringify(result),/private|LOCAL_BUSY|BAD_REQUEST|stack/);
 }
});
