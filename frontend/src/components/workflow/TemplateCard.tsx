import botLogo from "@/assets/bot-logo.svg"

interface Template {
  id: string
  name: string
  description: string
  icon: string
  iconBgColor?: string
  isPlaceholder?: boolean
}

interface TemplateCardProps {
  template: Template
  onSelect?: (template: Template) => void
  isSelected?: boolean
}

export function TemplateCard({
  template,
  onSelect,
  isSelected,
}: TemplateCardProps) {
  if (template.isPlaceholder) {
    return (
      <div className="bg-white border-2 border-dashed border-gray-200 rounded-xl p-6 flex items-center justify-center min-h-[140px]">
        <p className="text-gray-400 text-center">More templates coming soon!</p>
      </div>
    )
  }

  return (
    <div
      className={`bg-white border rounded-xl p-6 cursor-pointer transition-all hover:shadow-md min-h-[140px] ${
        isSelected
          ? "border-gray-900 border-2 shadow-md"
          : "border-gray-200 hover:border-gray-300"
      }`}
      onClick={() => onSelect?.(template)}
    >
      <div className="flex flex-col space-y-4">
        {/* Icon */}
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: template.iconBgColor || "#F2F2F3" }}
        >
          <img src={botLogo} alt="Bot Logo" className="w-5 h-5" />
        </div>

        {/* Content */}
        <div className="space-y-2">
          <h3 className="font-semibold text-gray-900 text-base">
            {template.name}
          </h3>

          <p className="text-sm text-gray-500 leading-relaxed">
            {template.description}
          </p>
        </div>
      </div>
    </div>
  )
}
