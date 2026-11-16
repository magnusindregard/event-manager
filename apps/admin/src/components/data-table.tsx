import { type ColumnDef as TanColumnDef, flexRender, type RowData, tableFeatures, useTable } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// Core features only for now; add rowSelectionFeature, columnPinningFeature, cellSelectionFeature
// etc. here as screens need them.
const features = tableFeatures({});
type Features = typeof features;
export type ColumnDef<T extends RowData> = TanColumnDef<Features, T>;

/**
 * TanStack Table rendered with the shadcn Table (ADR 0015). Server-driven: pagination, sorting
 * and filtering stay in the query; this component only renders. Grows features (selection,
 * inline editing, pinning) as the screens that need them land.
 */
export function DataTable<T extends RowData>({ columns, data, loading, empty, getRowId }: {
  columns: ColumnDef<T>[];
  data: T[];
  loading?: boolean;
  empty: ReactNode;
  getRowId?: (row: T) => string;
}) {
  const table = useTable({ features, data, columns, ...(getRowId ? { getRowId } : {}) });
  const rows = table.getRowModel().rows;

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader className="bg-muted/50">
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((h) => (
                <TableHead key={h.id}>
                  {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length ? (
            rows.map((row) => (
              <TableRow key={row.id}>
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id} className="align-top whitespace-normal">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                {loading ? "…" : empty}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
