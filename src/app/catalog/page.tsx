import { formatCents } from "@/lib/crs/money";
import { getProductsBySupplier, getSupplierCatalog } from "@/lib/db/queries";
import {
  Badge,
  Card,
  CardHead,
  PageHead,
  Table,
  Td,
  Th,
  titleCase,
} from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  const suppliers = await getSupplierCatalog();
  const catalogs = await Promise.all(
    suppliers.map(async (s) => ({
      supplier: s,
      products: await getProductsBySupplier(s.supplier_id),
    })),
  );

  return (
    <>
      <PageHead
        eyebrow="Supplier network"
        title="Catalog and volume ladders"
        sub="Every product carries the supplier's published single-buyer price and its volume break ladder. Pooling a zone's demand moves the order up that ladder; the ladder is what the whole model runs on, so it is shown in full rather than summarised."
      />

      <div className="space-y-8">
        {catalogs.map(({ supplier, products }) => (
          <Card key={supplier.supplier_id}>
            <CardHead
              title={supplier.supplier_name}
              sub={
                <>
                  Ships from {supplier.origin_city}, {supplier.origin_state} ·{" "}
                  {supplier.lead_time_days}-day lead · {supplier.terms} ·{" "}
                  {formatCents(supplier.min_order_cents)} minimum collective order ·{" "}
                  {supplier.product_count} SKUs
                </>
              }
              right={
                supplier.invoices_members_separately ? (
                  <Badge tone="guide">Invoices members separately</Badge>
                ) : (
                  <Badge tone="signal">Single invoice</Badge>
                )
              }
            />
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th>Category</Th>
                  <Th right>Pack</Th>
                  <Th right>List</Th>
                  <Th>Volume ladder</Th>
                  <Th right>Best</Th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const best = p.tiers.at(-1);
                  const bestSaving = best
                    ? p.list_price_cents - best.unit_price_cents
                    : 0;
                  return (
                    <tr key={p.id} className="hover:bg-ink-850">
                      <Td>
                        <p className="font-medium text-hi">{p.name}</p>
                        <p className="text-xs text-low">
                          {p.sku} · {p.cases_per_pallet}/pallet ·{" "}
                          {Number(p.case_weight_lb)} lb/case
                        </p>
                      </Td>
                      <Td>
                        <span className="text-xs text-mid">{titleCase(p.category)}</span>
                        {p.temp_class !== "dry" ? (
                          <Badge tone="route">{p.temp_class}</Badge>
                        ) : null}
                      </Td>
                      <Td right className="text-xs text-mid">{p.pack_description}</Td>
                      <Td right className="num text-mid">
                        {formatCents(p.list_price_cents)}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-1.5">
                          {p.tiers.map((t) => (
                            <span
                              key={t.min_cases}
                              className="num rounded border border-ink-700 px-1.5 py-0.5 text-[11px] text-mid"
                            >
                              <span className="text-low">{t.min_cases}+</span>{" "}
                              {formatCents(t.unit_price_cents)}
                            </span>
                          ))}
                        </div>
                      </Td>
                      <Td right>
                        <span className="num font-semibold text-guide">
                          −{formatCents(bestSaving)}
                        </span>
                        <p className="text-[11px] text-low">
                          {best
                            ? `${((bestSaving / p.list_price_cents) * 100).toFixed(1)}% at ${best.min_cases} cs`
                            : "no ladder"}
                        </p>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        ))}
      </div>
    </>
  );
}
