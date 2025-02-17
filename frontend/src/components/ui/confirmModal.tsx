import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog"

interface ConfirmModalProps {
  showModal: boolean
  setShowModal: (value: {
    open: boolean
    title: string
    description: string
  }) => void
  modalMessage: string
  modalTitle: string
  onConfirm: () => void
}
export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  showModal,
  setShowModal,
  modalMessage,
  modalTitle,
  onConfirm,
}) => (
  <Dialog
    open={showModal}
    onOpenChange={(v) => setShowModal({ open: v, title: "", description: "" })}
  >
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="text-xl font-bold text-red-600">
          {modalTitle}
        </DialogTitle>
        <DialogDescription className="text-gray-600">
          {modalMessage}
        </DialogDescription>
        <div className="flex justify-end gap-4">
          <DialogClose
            className="px-4 py-2 bg-gray-300 text-black rounded-lg hover:bg-gray-400"
            onClick={() =>
              setShowModal({ open: false, title: "", description: "" })
            }
          >
            Cancel
          </DialogClose>
          <button
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground shadow hover:bg-primary/90"
            onClick={() => {
              onConfirm()
              setShowModal({ open: false, title: "", description: "" })
            }}
          >
            OK
          </button>
        </div>
      </DialogHeader>
    </DialogContent>
  </Dialog>
)
