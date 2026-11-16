// 有理数运算：IMF 的编辑率、时间点与区间都是有理数。
// 全程用整数分子/分母保存，不引入浮点误差，保证收件清单可核对。

export function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function make(numerator, denominator = 1) {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new TypeError('有理数必须由整数构成');
  }
  if (denominator === 0) throw new RangeError('有理数分母不能为零');
  if (denominator < 0) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const divisor = gcd(numerator, denominator);
  return [numerator / divisor, denominator / divisor];
}

export function add(a, b) {
  return make(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
}

export function mul(a, b) {
  return make(a[0] * b[0], a[1] * b[1]);
}

// 有理数 a 乘以整数 k（repeatCount 等），结果仍是有理数
export function scale(a, k) {
  if (!Number.isInteger(k)) throw new TypeError('整数倍缩放需要整数');
  return make(a[0] * k, a[1]);
}

export function compare(a, b) {
  const left = a[0] * b[1];
  const right = b[0] * a[1];
  return left === right ? 0 : left < right ? -1 : 1;
}

// 转成秒：分子/分母，保留精确值之外给一个十进制近似值，仅用于人工阅读
export function toDecimal(a, precision = 6) {
  const value = a[0] / a[1];
  return Number(value.toFixed(precision));
}

// 把任意输入规范成 [分子, 分母]；接受两元数组或单个整数
export function from(input, label = '有理数值') {
  if (Array.isArray(input) && input.length === 2) return make(input[0], input[1]);
  if (Number.isInteger(input)) return make(input, 1);
  throw new TypeError(`${label}必须是两元整数数组或整数`);
}
