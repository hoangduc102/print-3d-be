import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class OrderItemDto {
  @ApiProperty({
    description: 'ID biến thể sản phẩm',
    example: '8331c08c-24c1-4185-b8b6-a6b91ac9c3c8',
  })
  @IsUUID()
  variantId: string;

  @ApiProperty({ description: 'Số lượng', example: 2 })
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional({
    description: 'Tỉ lệ in (%) so với kích thước gốc, mặc định 100',
    example: 100,
    default: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(500)
  scale?: number;

  @ApiPropertyOptional({
    description:
      'Đơn giá phía client (chỉ để tham khảo). Server luôn tự tính lại giá, không dùng giá trị này.',
    example: 35000,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;
}
