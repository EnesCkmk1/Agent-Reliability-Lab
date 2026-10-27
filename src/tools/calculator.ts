export function evaluateArithmetic(expression: string): number {
  const source = expression.replace(/\s+/g, "");
  if (source.length === 0 || source.length > 200) throw new Error("unsupported expression");
  if (!/^[\d.+\-*/()]+$/.test(source)) throw new Error("unsupported expression");
  let index = 0;

  const parseExpression = (): number => {
    let left = parseTerm();
    while (source[index] === "+" || source[index] === "-") {
      const operator = source[index]!;
      index += 1;
      const right = parseTerm();
      left = operator === "+" ? left + right : left - right;
    }
    return left;
  };

  const parseTerm = (): number => {
    let left = parseFactor();
    while (source[index] === "*" || source[index] === "/") {
      const operator = source[index]!;
      index += 1;
      const right = parseFactor();
      if (operator === "/" && right === 0) throw new Error("division by zero");
      left = operator === "*" ? left * right : left / right;
    }
    return left;
  };

  const parseFactor = (): number => {
    if (source[index] === "+" || source[index] === "-") {
      const sign = source[index] === "-" ? -1 : 1;
      index += 1;
      return sign * parseFactor();
    }
    if (source[index] === "(") {
      index += 1;
      const value = parseExpression();
      if (source[index] !== ")") throw new Error("missing parenthesis");
      index += 1;
      return value;
    }
    const start = index;
    while ((source[index]! >= "0" && source[index]! <= "9") || source[index] === ".") index += 1;
    if (start === index) throw new Error("expected number");
    const token = source.slice(start, index);
    if (token.split(".").length > 2) throw new Error("invalid number");
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error("invalid number");
    return value;
  };

  const value = parseExpression();
  if (index !== source.length) throw new Error("trailing input");
  return value;
}
