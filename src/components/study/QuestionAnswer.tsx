import Markdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

interface QuestionAnswerProps {
  text: string
}

export default function QuestionAnswer({ text }: QuestionAnswerProps) {
  return (
    <div className="question-response-body">
      <Markdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}
        components={{ img: () => null }}>
        {text}
      </Markdown>
    </div>
  )
}
