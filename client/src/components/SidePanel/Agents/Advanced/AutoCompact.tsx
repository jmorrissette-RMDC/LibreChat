import { useFormContext, Controller } from 'react-hook-form';
import {
  Switch,
  FormInput,
  HoverCard,
  HoverCardPortal,
  HoverCardContent,
  HoverCardTrigger,
  CircleHelpIcon,
} from '@librechat/client';
import type { AgentForm } from '~/common';
import { useLocalize } from '~/hooks';
import { ESide } from '~/common';

export default function AutoCompact() {
  const localize = useLocalize();
  const methods = useFormContext<AgentForm>();
  const { control, watch, setValue } = methods;
  const autoCompact = watch('auto_compact');

  return (
    <HoverCard openDelay={50}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div>{localize('com_ui_agent_auto_compact')}</div>
            <HoverCardTrigger>
              <CircleHelpIcon className="h-4 w-4 text-text-tertiary" />
            </HoverCardTrigger>
          </div>
          <Switch
            id="auto_compact"
            aria-label={localize('com_ui_agent_auto_compact')}
            checked={autoCompact ?? false}
            onCheckedChange={(checked) => setValue('auto_compact', checked, { shouldDirty: true })}
          />
        </div>
        {autoCompact === true && (
          <Controller
            name="compact_threshold"
            control={control}
            render={({ field }) => (
              <FormInput
                field={{
                  ...field,
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                    setValue('compact_threshold', Number(e.target.value), { shouldDirty: true }),
                }}
                containerClass="w-1/2"
                inputClass="w-full"
                label={localize('com_ui_agent_compact_threshold')}
                placeholder="80"
                type="number"
                labelClass="w-fit"
              />
            )}
          />
        )}
      </div>
      <HoverCardPortal>
        <HoverCardContent side={ESide.Top} className="w-80">
          <div className="space-y-2">
            <p className="text-sm text-text-secondary">
              {localize('com_ui_agent_auto_compact_info')}
            </p>
          </div>
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
}
