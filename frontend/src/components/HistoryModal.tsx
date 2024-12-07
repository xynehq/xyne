import { api } from "@/api"
import { useQuery } from "@tanstack/react-query"
import { SelectPublicChat } from "shared/types"
import { Trash2, MoreHorizontal, X } from "lucide-react"
import { useRouter } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"

const fetchChats = async () => {
  let items = []
  const response = await api.chat.history.$get({
    query: {
      page: 0,
    },
  })
  if (response.ok) {
    items = await response.json()
  }
  return items
}

const HistoryModal = ({
  onClose,
  pathname,
}: { onClose: () => void; pathname: string }) => {
  const [openModalIndex, setOpenModalIndex] = useState(null)
  const modalRef = useRef(null)

  useEffect(() => {
    const handleOutsideClick = (event) => {
      if (modalRef.current && !modalRef.current.contains(event.target)) {
        setOpenModalIndex(null) // Close the modal if the click is outside
      }
    }

    if (openModalIndex !== null) {
      document.addEventListener("mousedown", handleOutsideClick)
    }

    return () => {
      document.removeEventListener("mousedown", handleOutsideClick)
    }
  }, [openModalIndex])

  const router = useRouter()
  const {
    isPending,
    error,
    data: historyItems,
  } = useQuery<SelectPublicChat[]>({
    queryKey: ["all-connectors"],
    queryFn: fetchChats,
  })
  if (error) {
    return <p>Something went wrong...</p>
  }
  if (isPending) {
    return <p>Loading...</p>
  }
  let existingChatId = ""
  if (pathname.startsWith("/chat/")) {
    existingChatId = pathname.substring(6)
  }
  return (
    <div className="fixed left-[58px] top-0 max-w-sm w-[300px] h-[calc(100%-18px)] m-[6px] bg-[#F7FAFC] border-[0.5px] border-[#D7E0E9] rounded-[12px] flex flex-col select-none">
      <div className="flex justify-between items-center ml-[18px] mt-[14px]">
        <p className="text-lg text-[#1C1E1F] font-semibold text-[15px]">
          Chat History
        </p>
        <button
          onClick={onClose}
          className="flex items-center justify-center bg-white rounded-full w-[24px] h-[24px] mr-[14px] border-[0.5px] border-[#D7E0E9]"
        >
          <X stroke="#9EB6CE" size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-visible mt-[15px]">
        <ul>
          {historyItems.map((item, index) => (
            <li
              key={index}
              className={`group flex justify-between items-center ${item.externalId === existingChatId ? "bg-[#EBEFF2]" : ""} hover:bg-[#EBEFF2] rounded-[6px] pt-[8px] pb-[8px] ml-[8px] mr-[8px] relative`}
            >
              <span
                className="text-[14px] pl-[10px] pr-[10px] truncate cursor-pointer"
                onClick={() => {
                  router.navigate({
                    to: "/chat/$chatId",
                    params: { chatId: item.externalId },
                  })
                  item.extenalId
                }}
              >
                {item.title}
              </span>
              <MoreHorizontal
                size={16}
                className="invisible group-hover:visible mr-[10px] cursor-pointer"
                onClick={() =>
                  setOpenModalIndex((prev) => (prev === index ? null : index))
                }
              />
              {openModalIndex === index && (
                <span
                  ref={modalRef}
                  className="absolute z-10 bg-white border rounded-md shadow-md"
                  style={{
                    top: "70%",
                    left: "calc(100% - 10px)",
                  }}
                >
                  <button
                    className="flex text-[14px] text-red-500 py-[8px] px-[10px] w-full hover:bg-[#EBEFF2] items-center"
                    onClick={() => {
                      setOpenModalIndex(null)
                    }}
                  >
                    <Trash2 size={16} className="mr-2" />
                    Delete
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export default HistoryModal
