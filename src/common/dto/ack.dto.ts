import { ApiProperty } from '@nestjs/swagger';

/** Body of storefront commands that return nothing else (the contract wants a typed 200). */
export class AckDto {
  @ApiProperty({ example: true }) ok: true;
}

export const ACK: AckDto = { ok: true };
