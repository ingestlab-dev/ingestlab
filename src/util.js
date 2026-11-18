
export function cluster1d(items, key, tol) {
  const tagged = items.map((item) => ({ item, k: key(item) })).sort((a, b) => a.k - b.k);
  const out = [];
  for (const { item, k } of tagged) {
    const last = out[out.length - 1];
    if (last && Math.abs(k - last.key) <= tol) {
      last.items.push(item);
      last.key = last.key + (k - last.key) / last.items.length;
    } else {
      out.push({ key: k, items: [item] });
    }
  }
  return out;
}

// Compose affine matrices in application order: mul6(a, b) applies b first.
export function mul6(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function apply6(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function mean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}
