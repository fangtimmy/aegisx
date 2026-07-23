import {
  type Control,
  Controller,
  type FieldPath,
  type FieldValues,
} from "react-hook-form"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field"

export function NumberFieldControl<T extends FieldValues>({
  control,
  name,
  label,
  min,
  max,
  step,
  className,
}: {
  control: Control<T>
  name: FieldPath<T>
  label: string
  min?: number
  max?: number
  step?: number
  className?: string
}) {
  return (
    <Field className={className}>
      <FieldLabel>{label}</FieldLabel>
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <NumberField
            max={max}
            min={min}
            onValueChange={field.onChange}
            required
            step={step}
            value={field.value as number}
          >
            <NumberFieldGroup>
              <NumberFieldDecrement />
              <NumberFieldInput />
              <NumberFieldIncrement />
            </NumberFieldGroup>
          </NumberField>
        )}
        rules={{
          required: true,
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
        }}
      />
    </Field>
  )
}
