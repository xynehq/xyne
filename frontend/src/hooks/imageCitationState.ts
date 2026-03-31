import type { ImageCitation } from "shared/types"

export const appendImageCitation = (
  imageCitations: ImageCitation[],
  imageCitation: ImageCitation,
): ImageCitation[] => {
  const withoutDuplicate = imageCitations.filter(
    (existing) => existing.citationKey !== imageCitation.citationKey,
  )
  return [...withoutDuplicate, imageCitation]
}
