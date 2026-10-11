import { HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { ApiException } from './api-exception';

/** Validates & strips input against a Zod schema (contracts are the source of truth). */
@Injectable()
export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'validation_failed',
        'request validation failed',
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return result.data;
  }
}

export const zodPipe = <S extends ZodTypeAny>(schema: S) => new ZodValidationPipe(schema);
