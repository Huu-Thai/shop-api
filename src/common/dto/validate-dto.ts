import { plainToInstance } from 'class-transformer';
import { type ValidationError, validate } from 'class-validator';

function messages(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => [
    ...Object.values(e.constraints ?? {}).map((m) =>
      prefix ? `${prefix}.${m}` : m,
    ),
    ...messages(
      e.children ?? [],
      prefix ? `${prefix}.${e.property}` : e.property,
    ),
  ]);
}

/**
 * Validates a plain object against a request DTO with the API's rules (whitelist, no unknown
 * fields), for inputs that don't come through a controller (CSV imports). Returns the messages.
 */
export async function validateDto<T extends object>(
  cls: new () => T,
  value: object,
): Promise<{ dto: T; errors: string[] }> {
  const dto = plainToInstance(cls, value);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errors: messages(errors) };
}
