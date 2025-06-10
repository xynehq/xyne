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
  setShowModal: (
    value: Partial<{
      open: boolean
      title: string
      description: string
    }>,
  ) => void
  modalMessage: string
  modalTitle: string
  onConfirm?: () => void
}
export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  showModal,
  setShowModal,
  modalMessage,
  modalTitle,
  onConfirm,
}) => (
  <Dialog open={showModal} onOpenChange={(v) => setShowModal({ open: v })}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle className="text-xl font-bold text-primary">
          {modalTitle}
        </DialogTitle>
        <DialogDescription className="text-gray-600 dark:text-gray-400">
          {modalMessage}
        </DialogDescription>
        <div className="flex justify-end gap-4">
          <DialogClose
            className="px-4 py-2 bg-gray-300 dark:bg-gray-700 text-black dark:text-gray-200 rounded-lg hover:bg-gray-400 dark:hover:bg-gray-600"
            onClick={() => setShowModal({ open: false })}
          >
            Cancel
          </DialogClose>
          <button
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground shadow hover:bg-primary/90"
            onClick={() => {
              onConfirm && onConfirm()
              setShowModal({ open: false })
            }}
          >
            OK
          </button>
        </div>
      </DialogHeader>
    </DialogContent>
  </Dialog>
)
