import { createRoot } from "react-dom/client";
import {
  Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList,
} from "./components/ui/combobox";

export function createBaselinePicker(host) {
  const root = createRoot(host);
  return {
    update(options, selected, change) {
      const items = options.map(([id, label]) => ({ id, label }));
      root.render(
        <Combobox
          items={items}
          value={items.find(item => item.id === selected)}
          itemToStringLabel={item => item.label}
          itemToStringValue={item => item.id}
          isItemEqualToValue={(item, value) => item.id === value.id}
          onValueChange={item => change(item?.id ?? "")}
        >
          <label htmlFor="baseline-picker">Baseline</label>
          <ComboboxInput id="baseline-picker" placeholder="Search baselines" />
          <ComboboxContent>
            <ComboboxEmpty>No matching runs.</ComboboxEmpty>
            <ComboboxList>
              {item => <ComboboxItem key={item.id} value={item}>{item.label}</ComboboxItem>}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>,
      );
    },
    destroy() {
      root.unmount();
    },
  };
}
