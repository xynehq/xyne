import { createFileRoute } from '@tanstack/react-router'
import { RagTraceVirtualization } from '@/components/RagTraceVirtualization'
export const Route = createFileRoute('/_authenticated/trace/$chatId/$msgId')({
  component: RouteComponent,
})
// ...existing code...

function RouteComponent() {
  const { chatId, msgId } = Route.useParams();
  return (
    <div>
      <RagTraceVirtualization 
        chatId={chatId} 
        messageId={msgId}
        onClose={() => {}} 
      />
    </div>
  );
}