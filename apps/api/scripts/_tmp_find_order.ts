import { getPrisma, closePrisma } from "../src/lib/prisma";
(async () => {
  const prisma = await getPrisma();
  const user = await prisma.user.findUnique({ where: { email: "customer@kabadiwala.local" } });
  const orders = await prisma.transactionOrder.findMany({
    where: { OR: [{ buyerId: user!.id }, { sellerId: user!.id }] },
    select: { id: true, orderNumber: true, status: true, buyerId: true, sellerId: true, agreedTotalPaise: true, finalSettlementPaise: true },
    take: 5,
  });
  console.log(JSON.stringify({ userId: user!.id, orders }, null, 1));
  await closePrisma();
})();
