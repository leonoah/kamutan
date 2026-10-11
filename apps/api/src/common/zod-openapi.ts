import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApiErrorSchema } from '@kamutan/contracts';
import { ZodObject, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Loosely typed alias: zodToJsonSchema's generics trigger TS2589 / very slow checks.
const zodToJson = zodToJsonSchema as unknown as (schema: unknown, opts: unknown) => Record<string, unknown>;

export function toOpenApi(schema: ZodTypeAny): SchemaObject {
  const json = zodToJson(schema, { target: 'openApi3', $refStrategy: 'none' });
  delete json.$schema;
  return json as SchemaObject;
}

export const ApiZodBody = (schema: ZodTypeAny) => ApiBody({ schema: toOpenApi(schema) });

export const ApiZodResponse = (status: number, schema: ZodTypeAny, description?: string) =>
  ApiResponse({ status, schema: toOpenApi(schema), description });

/** Documents each key of a Zod object schema as a query parameter. */
export function ApiZodQuery(schema: ZodTypeAny) {
  if (!(schema instanceof ZodObject)) return applyDecorators();
  const shape = schema.shape as Record<string, ZodTypeAny>;
  return applyDecorators(
    ...Object.entries(shape).map(([name, s]) =>
      ApiQuery({ name, required: !s.isOptional(), schema: toOpenApi(s) }),
    ),
  );
}

export const ApiErrors = (...statuses: number[]) =>
  applyDecorators(...statuses.map((s) => ApiResponse({ status: s, schema: toOpenApi(ApiErrorSchema) })));
