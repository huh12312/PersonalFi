// SPDX-License-Identifier: MIT

/** Base class for every error the kernel raises. Carries a stable machine code. */
export class KernelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Thrown when an operation combines two `Money` values of different currencies. */
export class CurrencyMismatchError extends KernelError {
  readonly left: string;
  readonly right: string;

  constructor(left: string, right: string) {
    super('kernel.currency_mismatch', `cannot combine ${left} with ${right}`);
    this.left = left;
    this.right = right;
  }
}

/** Thrown when a value cannot be parsed into a kernel type. */
export class InvalidValueError extends KernelError {
  constructor(what: string, detail: string) {
    super('kernel.invalid_value', `invalid ${what}: ${detail}`);
  }
}
