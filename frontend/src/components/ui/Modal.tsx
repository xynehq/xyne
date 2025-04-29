import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

interface ModalProps {
  onConfirm: () => void;
  isOpen: boolean;
  setIsOpen: (val: { open: boolean; title: string; description: string }) => void;
  modelTitle: string;
  modelDescription: string;
}

const Modal: React.FC<ModalProps> = ({
  onConfirm,
  isOpen,
  setIsOpen,
  modelTitle,
  modelDescription,
}) => {
  return (
    <Dialog.Root open={isOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white p-6 rounded-lg shadow-lg w-96 z-50">
          <div className="flex justify-between items-center border-b pb-2 mb-4">
            <Dialog.Title className="text-lg font-semibold">
              {modelTitle}
            </Dialog.Title>
            <Dialog.Close
              className="text-gray-500 hover:text-gray-700"
              onClick={() => setIsOpen({ open: false, title: "", description: "" })}
            >
              <X className="w-5 h-5" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="text-gray-600 mb-4">
            {modelDescription}
          </Dialog.Description>
          <div className="flex justify-end gap-4">
            <Dialog.Close
              className="px-4 py-2 bg-gray-300 text-black rounded-lg hover:bg-gray-400"
              onClick={() => setIsOpen({ open: false, title: "", description: "" })}
            >
              Cancel
            </Dialog.Close>
            <button
              className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600"
              onClick={() => {
                onConfirm();
                setIsOpen({ open: false, title: "", description: "" });
              }}
            >
              OK
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default Modal;