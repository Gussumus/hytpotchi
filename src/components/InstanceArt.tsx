import { useEffect, useState } from 'react'
import { fileSrc } from '../lib/ipc'
import type { Instance } from '../lib/types'
import { Cover } from './Cover'

/** Обложка сборки: своя картинка, если задана, иначе пиксельный пейзаж */
export function InstanceArt({ inst, cols, rows }: { inst: Instance; cols?: number; rows?: number }) {
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
    if (inst.coverPath) fileSrc(inst.coverPath).then(setSrc)
    else setSrc('')
  }, [inst.coverPath])

  if (src && !failed) {
    return <img className="cover-img" src={src} alt="" onError={() => setFailed(true)} />
  }
  return <Cover seed={inst.id} accent={inst.accent ?? '#3ddc84'} cols={cols} rows={rows} />
}
