import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  Payment as PaymentModel,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  Shipment as ShipmentModel,
  ShipmentStatus,
} from '@prisma/client';
import { APP_CONSTANTS } from '../common/constants/app.constants';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { PrismaService } from '../database/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderItemDto } from './dto/order-item.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class OrderService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly orderInclude = {
    items: {
      include: {
        variant: {
          select: {
            id: true,
            name: true,
            material: {
              select: { id: true, name: true, color: true },
            },
            product: {
              select: {
                id: true,
                name: true,
                basePrice: true,
                images: { select: { url: true }, take: 1 },
              },
            },
          },
        },
      },
    },
    payment: true,
    shipment: true,
    address: true,
  } as const;

  async create(dto: CreateOrderDto, userId: string) {
    const { shippingAddress, items } = dto;

    return this.prisma.$transaction(async (tx) => {
      // 1️⃣ Server tự tính giá từng item (không tin giá client gửi lên)
      const orderItemsData = await this.priceItems(tx, items);

      // 2️⃣ Tổng tiền = Σ đơn giá × số lượng + phí vận chuyển
      const totalAmount = orderItemsData.reduce(
        (sum, item) => sum.add(item.price.mul(item.quantity)),
        new Decimal(APP_CONSTANTS.ORDER.SHIPPING_FEE),
      );

      // 3️⃣ TẠO ADDRESS (AUTO FILL)
      const address = await tx.address.create({
        data: {
          userId,
          recipient: shippingAddress.recipient,
          phone: shippingAddress.phone,
          address1: shippingAddress.addressText,
          city: 'Ho Chi Minh City',
          state: 'Ho Chi Minh',
          postal: '700000',
          country: 'Vietnam',
          isDefault: false,
        },
      });

      // 4️⃣ TẠO ORDER (ĐÃ CÓ totalAmount)
      const order = await tx.order.create({
        data: {
          userId,
          addressId: address.id,
          status: 'PENDING',
          totalAmount,
          items: {
            create: orderItemsData,
          },
        },
        include: {
          items: true,
          address: true,
        },
      });

      return order;
    });
  }

  async findAll(
    userId: string | undefined,
    status: OrderStatus | undefined,
    currentUser?: JwtPayload,
  ) {
    const scopedUserId =
      currentUser && !this.isAdmin(currentUser) ? currentUser.sub : userId;

    return this.prisma.order.findMany({
      where: {
        ...(scopedUserId ? { userId: scopedUserId } : {}),
        ...(status ? { status } : {}),
      },
      include: this.orderInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, currentUser: JwtPayload) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: this.orderInclude,
    });

    if (!order) {
      throw new NotFoundException('Order khong ton tai');
    }

    this.assertOwnership(order.userId, currentUser);
    return order;
  }

  async update(id: string, dto: UpdateOrderDto, currentUser: JwtPayload) {
    const existing = await this.prisma.order.findUnique({
      where: { id },
      include: {
        payment: true,
        shipment: true,
        user: { select: { id: true } },
      },
    });

    if (!existing) {
      throw new NotFoundException('Order khong ton tai');
    }

    this.assertOwnership(existing.userId, currentUser);

    // Khách hàng chỉ được huỷ đơn của mình khi đơn còn PENDING
    if (!this.isAdmin(currentUser)) {
      const onlyCancelling =
        dto.status === OrderStatus.CANCELLED &&
        Object.keys(dto).every((key) => key === 'status');
      if (!onlyCancelling) {
        throw new ForbiddenException('Ban chi co the huy don hang');
      }
      if (existing.status !== OrderStatus.PENDING) {
        throw new BadRequestException('Chi co the huy don hang dang cho xu ly');
      }
    }

    if (dto.items && dto.items.length === 0) {
      throw new BadRequestException('Danh sach san pham khong hop le');
    }

    if (dto.addressId) {
      await this.ensureAddressBelongsToUser(dto.addressId, existing.userId);
    }

    const pricedItems = dto.items
      ? await this.priceItems(this.prisma, dto.items)
      : null;

    const totalAmount =
      dto.totalAmount ??
      (pricedItems
        ? pricedItems.reduce(
            (sum, item) => sum + Number(item.price) * item.quantity,
            0,
          ) + APP_CONSTANTS.ORDER.SHIPPING_FEE
        : Number(existing.totalAmount));

    return this.prisma.$transaction(async (tx) => {
      if (dto.items) {
        await tx.orderItem.deleteMany({ where: { orderId: id } });
      }

      const updated = await tx.order.update({
        where: { id },
        data: {
          addressId: dto.addressId ?? existing.addressId,
          status: dto.status ?? existing.status,
          totalAmount,
          items: pricedItems ? { create: pricedItems } : undefined,
          payment: this.buildPaymentWrite(
            existing.payment,
            dto.payment,
            totalAmount,
          ),
          shipment: this.buildShipmentWrite(existing.shipment, dto.shipment),
        },
        include: this.orderInclude,
      });

      return updated;
    });
  }

  async remove(id: string, currentUser: JwtPayload) {
    await this.findOne(id, currentUser);
    return this.prisma.order.delete({
      where: { id },
      include: this.orderInclude,
    });
  }

  private toDate(value?: string) {
    return value ? new Date(value) : undefined;
  }

  private buildPaymentWrite(
    existing: PaymentModel | null,
    data: UpdateOrderDto['payment'],
    fallbackAmount: number,
  ) {
    if (!data) {
      return undefined;
    }

    if (existing) {
      return {
        update: {
          method: data.method,
          status: data.status,
          amount: data.amount ?? fallbackAmount,
          transactionId: data.transactionId,
        },
      };
    }

    return {
      create: {
        method: data.method ?? PaymentMethod.CREDIT_CARD,
        status: data.status ?? PaymentStatus.UNPAID,
        amount: data.amount ?? fallbackAmount,
        transactionId: data.transactionId,
      },
    };
  }

  private buildShipmentWrite(
    existing: ShipmentModel | null,
    data: UpdateOrderDto['shipment'],
  ) {
    if (!data) {
      return undefined;
    }

    if (existing) {
      return {
        update: {
          carrier: data.carrier,
          trackingNo: data.trackingNo,
          status: data.status,
          shippedAt: this.toDate(data.shippedAt),
          deliveredAt: this.toDate(data.deliveredAt),
        },
      };
    }

    return {
      create: {
        carrier: data.carrier,
        trackingNo: data.trackingNo,
        status: data.status ?? ShipmentStatus.PREPARING,
        shippedAt: this.toDate(data.shippedAt),
        deliveredAt: this.toDate(data.deliveredAt),
      },
    };
  }

  private async ensureAddressBelongsToUser(addressId: string, userId: string) {
    const address = await this.prisma.address.findUnique({
      where: { id: addressId },
      select: { userId: true },
    });

    if (!address) {
      throw new NotFoundException('Address khong ton tai');
    }

    if (address.userId !== userId) {
      throw new ForbiddenException('Dia chi khong thuoc nguoi dung nay');
    }
  }

  /**
   * Tính đơn giá cho từng item phía server.
   * Đơn giá = basePrice × material.priceFactor × scale / 100 (làm tròn tới đồng),
   * khớp với `variant.price` mà GET /products/:id trả về cho FE.
   */
  private async priceItems(
    client: Prisma.TransactionClient,
    items: OrderItemDto[],
  ) {
    const ids = [...new Set(items.map((i) => i.variantId))];
    const variants = await client.variant.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        product: { select: { basePrice: true } },
        material: { select: { priceFactor: true } },
      },
    });

    // So với số id KHÔNG trùng: 1 variant có thể xuất hiện nhiều lần với scale khác nhau
    if (variants.length !== ids.length) {
      throw new NotFoundException('Một hoặc nhiều variant không tồn tại');
    }

    const byId = new Map(variants.map((v) => [v.id, v]));
    return items.map((item) => {
      const variant = byId.get(item.variantId)!;
      return {
        variantId: item.variantId,
        quantity: item.quantity,
        price: this.unitPrice(
          variant.product.basePrice,
          variant.material.priceFactor,
          item.scale ?? 100,
        ),
      };
    });
  }

  private unitPrice(
    basePrice: Prisma.Decimal,
    priceFactor: number | null,
    scale: number,
  ) {
    return new Decimal(basePrice)
      .mul(priceFactor ?? 1)
      .mul(scale)
      .div(100)
      .toDecimalPlaces(0);
  }

  private assertOwnership(orderUserId: string, currentUser?: JwtPayload) {
    if (!currentUser) {
      throw new ForbiddenException('Khong xac dinh nguoi dung');
    }
    if (this.isAdmin(currentUser)) {
      return;
    }
    if (orderUserId !== currentUser.sub) {
      throw new ForbiddenException('Khong co quyen truy cap don hang nay');
    }
  }

  private isAdmin(user?: JwtPayload) {
    return user?.role === 'ADMIN';
  }
}
