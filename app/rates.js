//rates have to be reciprocal: a round trip through any pair gives back the same amount

export function assertReciprocal(rates, source) {
  for (const base in rates) {
    for (const counter in rates[base]) {
      const back = rates[counter]?.[base];

      if (back !== undefined && Math.abs(rates[base][counter] * back - 1) > 1e-9) {
        throw new Error(`${source}: ${base}/${counter} and ${counter}/${base} are not reciprocal`);
      }
    }
  }
}
