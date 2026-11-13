// Adapted from the shadcn/ui Base Nova combobox registry component (MIT).
// https://ui.shadcn.com/r/styles/base-nova/combobox.json
import { Combobox as Primitive } from "@base-ui/react/combobox";
import { Check, ChevronDown } from "lucide-react";

export const Combobox = Primitive.Root;

export function ComboboxInput(props) {
  return (
    <div className="relative" data-slot="input-group">
      <Primitive.Input data-slot="combobox-input" className="baseline-input" {...props} />
      <Primitive.Trigger data-slot="combobox-trigger" className="baseline-trigger" aria-label="Show baselines">
        <ChevronDown aria-hidden="true" size={16} />
      </Primitive.Trigger>
    </div>
  );
}

export function ComboboxContent(props) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner sideOffset={6} align="start" className="z-50">
        <Primitive.Popup data-slot="combobox-content" className="baseline-popup" {...props} />
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}

export function ComboboxList(props) {
  return <Primitive.List data-slot="combobox-list" className="baseline-list" {...props} />;
}

export function ComboboxEmpty(props) {
  return <Primitive.Empty data-slot="combobox-empty" className="baseline-empty" {...props} />;
}

export function ComboboxItem({ children, ...props }) {
  return (
    <Primitive.Item data-slot="combobox-item" className="baseline-item" {...props}>
      {children}
      <Primitive.ItemIndicator className="ml-auto shrink-0">
        <Check aria-hidden="true" size={16} />
      </Primitive.ItemIndicator>
    </Primitive.Item>
  );
}
