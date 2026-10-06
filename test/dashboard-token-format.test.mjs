import test from 'node:test';
import assert from 'node:assert/strict';
import {formatToken,tokenValueMarkup} from '../src/dashboard-v2-client.mjs';

test('Token display follows reference magnitude thresholds, zh-CN grouping and at most two decimals without padding',()=>{
  const cases=[[272101035,'2.72 亿'],[93863285,'9.39 千万'],[3307048,'3.31 百万'],[543898,'543,898'],[999999,'999,999'],[1000000,'1 百万'],[9999999,'10 百万'],[10000000,'1 千万'],[99999999,'10 千万'],[100000000,'1 亿'],[125000000,'1.25 亿'],[120000000,'1.2 亿'],[-93863285,'-9.39 千万'],[-100000000,'-1 亿'],[1234.567,'1,234.57'],[0,'0']];
  for(const [value,expected] of cases)assert.equal(formatToken(value),expected,String(value));
  for(const unknown of [null,undefined,NaN,Infinity,'unknown'])assert.equal(formatToken(unknown),'未记录');
});

test('Compact Token text keeps the original precise value in title and accessible description; unknown never becomes zero',()=>{
  const source={total:272101035,zero:0,missing:null},before=JSON.stringify(source),markup=tokenValueMarkup(source.total);
  assert.match(markup,/>2\.72 亿<\/span>/);assert.match(markup,/title="精确 Token：272101035"/);assert.match(markup,/aria-description="精确 Token：272101035"/);
  assert.match(tokenValueMarkup(source.zero),/title="精确 Token：0".*>0<\/span>/);assert.match(tokenValueMarkup(source.missing),/>未记录<\/span>/);assert.doesNotMatch(tokenValueMarkup(source.missing),/Token：0/);
  assert.equal(JSON.stringify(source),before);assert.equal(source.total,272101035);
});
