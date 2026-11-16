import test from 'node:test';
import assert from 'node:assert/strict';
import { add, gcd, make, mul, scale, toDecimal, from } from '../src/rational.mjs';

test('有理数约分到最简并统一负分母', () => {
  assert.deepEqual(make(4, 8), [1, 2]);
  assert.deepEqual(make(3, -6), [-1, 2]);
  assert.throws(() => make(1, 0), RangeError);
  assert.throws(() => make(1.5, 2), TypeError);
});

test('不同编辑率下的时间相加保持精确', () => {
  // 24000/1001 编辑率下 12000 个编辑单位 = 12000 / (24000/1001) = 500.5 秒
  const rate24 = make(24000, 1001);
  const segmentA = mul(make(12000, 1), make(rate24[1], rate24[0]));
  const segmentB = scale(mul(make(24, 1), make(1, 24)), 2); // 24/24 重复两次 = 2 秒
  const total = add(segmentA, segmentB);
  assert.equal(toDecimal(segmentA), 500.5);
  assert.equal(toDecimal(total), 502.5);
  assert.deepEqual(segmentB, [2, 1]);
});

test('from 接受整数与两元数组，拒绝非法输入', () => {
  assert.deepEqual(from(5), [5, 1]);
  assert.deepEqual(from([6, 4]), [3, 2]);
  assert.throws(() => from('x'), TypeError);
  assert.throws(() => from([1, 2, 3]), TypeError);
});

test('gcd 处理零与负数', () => {
  assert.equal(gcd(0, 7), 7);
  assert.equal(gcd(-12, 8), 4);
});
