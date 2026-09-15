import { SegmentEditor } from "../../SegmentEditor";
import { segmentOptions } from "../../options";

export default async function NewSegmentPage() {
  const { products, categories } = await segmentOptions();
  return <SegmentEditor products={products} categories={categories} />;
}
