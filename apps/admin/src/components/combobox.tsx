import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface Common {
  id?: string;
  options: readonly string[];
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  label?: (option: string) => string;
}
type Single = Common & { multiple?: false; value: string; onChange(value: string): void };
type Multiple = Common & { multiple: true; value: string[]; onChange(value: string[]): void };

/** Searchable select (Popover + cmdk). Single or multiple; multiple shows the picks as badges. */
export function Combobox(props: Single | Multiple) {
  const [open, setOpen] = useState(false);
  const label = props.label ?? ((o: string) => o);
  const selected = props.multiple ? props.value : [props.value];

  const pick = (option: string) => {
    if (props.multiple) {
      props.onChange(selected.includes(option) ? selected.filter((v) => v !== option) : [...selected, option]);
    } else {
      props.onChange(option);
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={props.id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={props.disabled}
          className="h-auto min-h-9 w-full justify-between font-normal"
        >
          <span className="flex flex-wrap gap-1 text-left">
            {props.multiple ? (
              selected.length ? selected.map((v) => <Badge key={v} variant="secondary">{label(v)}</Badge>) : <span className="text-muted-foreground">{props.placeholder}</span>
            ) : (
              props.value ? label(props.value) : <span className="text-muted-foreground">{props.placeholder}</span>
            )}
          </span>
          <ChevronsUpDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder={props.searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{props.emptyText}</CommandEmpty>
            <CommandGroup>
              {props.options.map((o) => (
                <CommandItem key={o} value={o} keywords={[label(o)]} onSelect={() => pick(o)}>
                  <CheckIcon className={cn(selected.includes(o) ? "opacity-100" : "opacity-0")} />
                  {label(o)}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
