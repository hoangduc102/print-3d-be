import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { OrderService } from './order.service';
import { APP_CONSTANTS } from '../common/constants/app.constants';

const customer = { sub: 'user-1', role: 'CUSTOMER' } as any;
const admin = { sub: 'admin-1', role: 'ADMIN' } as any;

const shippingAddress = {
  recipient: 'Nguyen Van A',
  phone: '0900000000',
  email: 'a@example.com',
  addressText: '1 Đường ABC',
};

describe('OrderService', () => {
  const tx = {
    variant: { findMany: jest.fn() },
    address: { create: jest.fn() },
    order: { create: jest.fn() },
  };
  const prismaMock = {
    $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    order: { findUnique: jest.fn(), update: jest.fn() },
  } as unknown as any;

  let service: OrderService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OrderService(prismaMock);
    tx.address.create.mockResolvedValue({ id: 'addr-1' });
    tx.order.create.mockImplementation(({ data }) => Promise.resolve(data));
  });

  describe('create', () => {
    it('tính giá phía server: basePrice × priceFactor × scale, bỏ qua giá client', async () => {
      tx.variant.findMany.mockResolvedValue([
        {
          id: 'v1',
          product: { basePrice: new Decimal(100000) },
          material: { priceFactor: 1.2 },
        },
      ]);

      // order.create được mock trả lại nguyên `data` đã gửi vào Prisma
      const order: any = await service.create(
        {
          shippingAddress,
          items: [{ variantId: 'v1', quantity: 2, scale: 150, price: 1 }],
        },
        'user-1',
      );

      const item = order.items.create[0];
      // 100000 × 1.2 × 150% = 180000
      expect(Number(item.price)).toBe(180000);
      expect(Number(order.totalAmount)).toBe(
        180000 * 2 + APP_CONSTANTS.ORDER.SHIPPING_FEE,
      );
    });

    it('cho phép cùng 1 variant xuất hiện nhiều lần với scale khác nhau', async () => {
      tx.variant.findMany.mockResolvedValue([
        {
          id: 'v1',
          product: { basePrice: new Decimal(50000) },
          material: { priceFactor: null },
        },
      ]);

      // order.create được mock trả lại nguyên `data` đã gửi vào Prisma
      const order: any = await service.create(
        {
          shippingAddress,
          items: [
            { variantId: 'v1', quantity: 1 },
            { variantId: 'v1', quantity: 1, scale: 200 },
          ],
        },
        'user-1',
      );

      expect(order.items.create.map((i) => Number(i.price))).toEqual([
        50000, 100000,
      ]);
      expect(Number(order.totalAmount)).toBe(
        150000 + APP_CONSTANTS.ORDER.SHIPPING_FEE,
      );
    });

    it('báo lỗi khi variant không tồn tại', async () => {
      tx.variant.findMany.mockResolvedValue([]);

      await expect(
        service.create(
          { shippingAddress, items: [{ variantId: 'missing', quantity: 1 }] },
          'user-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    const pendingOrder = {
      id: 'o1',
      userId: 'user-1',
      status: OrderStatus.PENDING,
      addressId: 'addr-1',
      totalAmount: new Decimal(100000),
      payment: { status: PaymentStatus.UNPAID },
      shipment: null,
    };

    it('khách hàng được huỷ đơn PENDING của mình', async () => {
      prismaMock.order.findUnique.mockResolvedValue(pendingOrder);
      prismaMock.$transaction.mockImplementationOnce((fn) =>
        fn({
          orderItem: { deleteMany: jest.fn() },
          order: { update: jest.fn().mockResolvedValue({ id: 'o1' }) },
        }),
      );

      await expect(
        service.update('o1', { status: OrderStatus.CANCELLED }, customer),
      ).resolves.toEqual({ id: 'o1' });
    });

    it('khách hàng không được tự đổi trạng thái khác hoặc sửa tổng tiền', async () => {
      prismaMock.order.findUnique.mockResolvedValue(pendingOrder);

      await expect(
        service.update('o1', { status: OrderStatus.DELIVERED }, customer),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.update(
          'o1',
          { status: OrderStatus.CANCELLED, totalAmount: 0 },
          customer,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('khách hàng không huỷ được đơn đã xác nhận', async () => {
      prismaMock.order.findUnique.mockResolvedValue({
        ...pendingOrder,
        status: OrderStatus.CONFIRMED,
      });

      await expect(
        service.update('o1', { status: OrderStatus.CANCELLED }, customer),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('admin vẫn đổi được trạng thái', async () => {
      prismaMock.order.findUnique.mockResolvedValue(pendingOrder);
      const update = jest.fn().mockResolvedValue({ id: 'o1' });
      prismaMock.$transaction.mockImplementationOnce((fn) =>
        fn({ orderItem: { deleteMany: jest.fn() }, order: { update } }),
      );

      await service.update('o1', { status: OrderStatus.PRINTING }, admin);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: OrderStatus.PRINTING }),
        }),
      );
    });
  });
});
